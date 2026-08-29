import {
  DiscogsHttpError,
  searchReleases,
  type DiscogsReleaseCandidate,
  type DiscogsSearchQuery,
} from "./discogs";
import {
  fetchReleaseTrackArtists,
  MusicBrainzHttpError,
  searchArtistCandidates,
  searchReleaseCandidates,
  type MbArtistCandidate,
  type MbReleaseCandidate,
  type MbReleaseSearchQuery,
} from "./musicbrainz";
import { pickArtistFromSearch } from "./artist-identity";
import { editDistance } from "./title-similarity";
import type { ItemType } from "../domain/types";

// ---------------------------------------------------------------------------
// Release identifier resolution
//
// Turn a hand-written artist and title into catalogue identifiers. Both
// providers answer a query with a confidently ranked list whether or not they
// hold the record, so the ranking is never the answer — every candidate is
// re-checked here against what was actually asked for, and nothing that fails
// that check is stored.
//
// Discogs is queried first because it is the higher-recall source: over the
// 101 eval fixtures it resolved 94 against MusicBrainz's 54, and every record
// MusicBrainz held Discogs held too. MusicBrainz is still queried every time,
// because recall is not what it is for — Cover Art Archive artwork, artist
// watch baselines and release alerts are all keyed on MusicBrainz ids and
// cannot consume a Discogs one.
//
// Abstaining is a first-class outcome. Roughly 7% of the fixtures exist in
// neither database, and a wrong id is worse than no id: it silently attaches
// another record's artwork, tracklist and release alerts to this one.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Matching (pure)
//
// Kept exported and free of network calls so the interesting rules can be
// tested directly, the way `pickArtistFromSearch` is in artist-identity.ts.
// ---------------------------------------------------------------------------

/**
 * Canonical comparison form: lowercased, diacritics stripped, everything that
 * is not a letter or digit collapsed to single spaces.
 *
 * Diacritic stripping is not cosmetic here. The catalogue is largely Latin
 * American and Iberian, and shop-written sleeves routinely drop accents that
 * the databases keep — "Estados De Animo" against "Estados de Ánimo" is the
 * common case, not the exotic one.
 */
export function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Everything before the first credit conjunction: "Celia Cruz y La Sonora
 * Matancera" becomes "Celia Cruz".
 *
 * This was the highest-value single normalisation observed while resolving the
 * fixtures — the dominant difference between a shop-written artist string and
 * a catalogue credit. It is also destructive: "Earth, Wind & Fire" becomes
 * "Earth, Wind". That is tolerable only because the stripped form is never the
 * sole basis for a match. It is one extra query in the cascade, and one extra
 * variant that `artistSimilarity` may match on — the full string is always
 * tried too, so a band whose name contains a conjunction still verifies on its
 * own terms.
 */
export function stripCreditClause(artist: string): string {
  const match =
    /\s*(?:\/|\s(?:y|e|et|con|and|with|feat\.?|featuring|presents|pres\.?|vs\.?|&|\+)\s)\s*/i.exec(
      artist,
    );
  return match ? artist.slice(0, match.index).trim() : artist.trim();
}

/** A containment match is strong evidence but not proof, so it scores below 1. */
const CONTAINMENT_SIMILARITY = 0.9;

/** Below this length, one string sits inside another by coincidence far too often. */
const MIN_CONTAINMENT_LENGTH = 4;

/**
 * Ceiling applied when two strings disagree about their numbers. Deliberately
 * below every acceptance threshold: a digit difference is disqualifying, not
 * merely expensive.
 */
const DIGIT_MISMATCH_CEILING = 0.5;

/**
 * The numbers in a string, in order. Digits do not behave like letters here.
 * One letter apart is usually a typo or a transliteration; one digit apart is
 * a different record — "Guaco 76" and "Guaco 77" are 87% similar by edit
 * distance and are two separate albums. Accepting that pair is how a wrong id
 * reached the fixture manifest on an earlier pass.
 */
function digitSignature(normalized: string): string {
  return (normalized.match(/\d+/g) ?? []).join(" ");
}

/**
 * How alike two strings are, 0–1, after normalisation.
 *
 * Word-boundary containment is treated as near-identity rather than scored by
 * edit distance, because the fixtures' most common title difference is a
 * subtitle present on one side only — "Compact Jazz" against "Compact Jazz:
 * Astrud Gilberto" is the same record, but shares less than half its
 * characters and would fail any distance threshold loose enough to be useful.
 */
export function similarity(a: string, b: string, allowContainment = true): number {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  // Anchored containment only — a prefix or a suffix, never the middle.
  //
  // Both anchors earn their place on the fixture set. Prefix covers a dropped
  // subtitle. Suffix covers the two databases naming one record differently:
  // Discogs files "Compact Jazz: Astrud Gilberto" as the self-titled "Astrud
  // Gilberto", and only the suffix rule bridges them.
  //
  // Mid-string containment covers nothing and costs: "Vibes of Barry Brown"
  // sits in the middle of "More Vibes of Barry Brown Along With Stama Rank",
  // which is a different record, and matching them was a false id.
  const contained =
    allowContainment &&
    shorter.length >= MIN_CONTAINMENT_LENGTH &&
    (longer.startsWith(`${shorter} `) || longer.endsWith(` ${shorter}`));

  // Containment outranks the digit rule. The digits that break a containment
  // match are in the part one side does not have at all — a year inside a
  // subtitle, as in "Beat Girls Español!" against "Beat Girls Español! (1960s
  // She-Pop From Spain)". Capping those cost two fixtures their hit. The pair
  // the rule exists for, "Guaco 76" against "Guaco 77", is not a containment
  // match in the first place, so it still gets capped below.
  if (contained) return CONTAINMENT_SIMILARITY;

  const raw = 1 - editDistance(na, nb) / longer.length;
  if (digitSignature(na) !== digitSignature(nb)) return Math.min(raw, DIGIT_MISMATCH_CEILING);
  return raw;
}

function tokensOf(value: string): string[] {
  const normalized = normalizeForMatch(value);
  return normalized ? normalized.split(" ") : [];
}

/**
 * Whether every word asked for appears in the candidate.
 *
 * Directional on purpose, and that direction is the whole safeguard. A
 * database credit that is LONGER than the sleeve is the normal case — the
 * sleeve says "Pacho", "Bana" or "Natural Black" and the catalogue says "Pacho
 * Alonso", "Bana Et Son Orchestre", "Natural Black / Sydney Mills All Stars".
 * A credit that is SHORTER than what was asked for is a different, less
 * specific entity, which is how MusicBrainz's "Pacho" (a German rapper) came
 * back for Pacho Alonso. Subset one way, never the other.
 *
 * Order-insensitive, which also handles a reordered multi-artist credit:
 * "Jean-Philippe Collard & Pascal Rogé" against "Satie / Pascal Rogé,
 * Jean-Philippe Collard".
 */
function tokenSubset(asked: string[], candidate: string[]): boolean {
  if (asked.length === 0) return false;
  const available = new Set(candidate);
  return asked.every((token) => available.has(token));
}

/**
 * Artist similarity, taking the best of the four full/credit-stripped
 * pairings. Either side may be the one carrying the backing band, so both are
 * stripped and all combinations compared.
 *
 * Containment is disabled here. It earns its place on titles, where one side
 * routinely omits a subtitle, but on names it is actively wrong: "Pacho" sits
 * inside "Pacho Alonso" and they are different artists. The case containment
 * would have covered — a bare name against a full backing-band credit — is
 * already handled by credit stripping, which is the principled route to it.
 */
export function artistSimilarity(asked: string, candidate: string): number {
  const askedVariants = new Set([asked, stripCreditClause(asked)]);
  const candidateVariants = new Set([candidate, stripCreditClause(candidate)]);
  const candidateTokens = tokensOf(candidate);

  let best = 0;
  for (const left of askedVariants) {
    if (
      normalizeForMatch(left).length >= MIN_CONTAINMENT_LENGTH &&
      tokenSubset(tokensOf(left), candidateTokens)
    ) {
      best = Math.max(best, CONTAINMENT_SIMILARITY);
    }
    for (const right of candidateVariants) {
      best = Math.max(best, similarity(left, right, false));
    }
  }
  return best;
}

/** Discogs' and MusicBrainz's placeholder for a compilation with no single act. */
function isVariousArtists(name: string): boolean {
  return /^(?:various|various artists|v ?a)$/.test(normalizeForMatch(name));
}

/**
 * Under the compilation waiver the title carries the whole burden, so it has to
 * clear more than the ordinary bar — a containment match qualifies, an
 * edit-distance near-miss does not.
 */
const VARIOUS_TITLE_MIN = 0.85;

export interface ReleaseQuery {
  artist: string;
  title: string;
  year?: number | null;
}

export interface CandidateScore {
  artist: number;
  title: number;
  /** The mean of the two, and what `MIN_CONFIDENCE` is applied to. */
  confidence: number;
  accepted: boolean;
}

export interface MatchThresholds {
  /**
   * Neither field may be weak on its own. A right artist with a wrong title is
   * a different record by the same act; a right title with a wrong artist is
   * one of the hundreds of unrelated records sharing a common title.
   */
  artist: number;
  title: number;
  /** …and their mean must clear this, so two barely-passing halves still fail. */
  confidence: number;
}

/**
 * Argued for, not yet measured. These are the numbers the resolution eval
 * exists to set: raising them trades resolution rate for a lower false-ID
 * rate, and the two are not equally costly — a wrong id is written into
 * music_items and silently poisons artwork and release alerts downstream,
 * while a miss leaves a row that can be retried.
 */
export const DEFAULT_THRESHOLDS: MatchThresholds = {
  artist: 0.72,
  title: 0.72,
  confidence: 0.82,
};

/**
 * Score one candidate against what was asked for.
 *
 * Note what is absent: the provider's own relevance score, and the year. The
 * relevance score is excluded because it measures how well the document
 * matched the query rather than whether the query described a real record —
 * every false positive observed while resolving the fixtures scored 100. The
 * year is excluded from acceptance because identity here is the work, and a
 * work's pressings span decades; a 1962 reissue of a 1957 album is the same
 * answer. Year is used only to order equally credible candidates.
 */
export function scoreCandidate(
  query: ReleaseQuery,
  candidate: { artist: string; title: string },
  thresholds: MatchThresholds = DEFAULT_THRESHOLDS,
): CandidateScore {
  const title = similarity(query.title, candidate.title);

  // Compilations. Discogs credits a compilation to "Various" where the sleeve
  // names the act that fronts it, so artist similarity is ~0 against a record
  // that is genuinely the right one — three fixtures were lost this way.
  //
  // "Various" is not a wrong artist; it is the absence of an artist claim. So
  // the artist test is waived and the title must carry the decision alone, at
  // a higher bar. The second clause covers Discogs folding the act into the
  // title, as in "PIPO'S O Encontro Da Massa Vol. 4" for "Pipo's 4 — O
  // Encontro da Massa": every word asked for is there, just not where the
  // field boundary says it should be.
  //
  // Deliberately NOT generalised to non-compilations. Matching on title tokens
  // alone would readmit "Vibes of Barry Brown" as "More Vibes of Barry Brown
  // Along With Stama Rank", which is exactly the false id anchored containment
  // was narrowed to prevent.
  if (isVariousArtists(candidate.artist) && !isVariousArtists(query.artist)) {
    const askedTokens = [...tokensOf(query.artist), ...tokensOf(query.title)];
    const candidateTokens = tokensOf(candidate.title);
    const wordsAccountedFor = tokenSubset(askedTokens, candidateTokens);

    // Every number asked for must appear somewhere in the candidate title.
    // Extra numbers on the candidate side are fine — they are years in a
    // subtitle. A number we asked for and did not get back is a different
    // volume: searching "Pipo's 4 — O Encontro da Massa" returns both Vol. 4
    // and the Vol. 2 record, whose titles are equally good matches, and only
    // the missing 4 separates them. The digit lives in the artist field here,
    // which is why this checks the whole asked string and not just the title.
    const digitsAsked = new Set(askedTokens.filter((token) => /^\d+$/.test(token)));
    const candidateDigits = new Set(candidateTokens.filter((token) => /^\d+$/.test(token)));
    const numbersAccountedFor = [...digitsAsked].every((digit) => candidateDigits.has(digit));

    const accepted = numbersAccountedFor && (title >= VARIOUS_TITLE_MIN || wordsAccountedFor);
    return {
      artist: 0,
      title,
      // The title is the only evidence, so it is the whole confidence.
      confidence: accepted ? Math.max(title, VARIOUS_TITLE_MIN) : title,
      accepted,
    };
  }

  const artist = artistSimilarity(query.artist, candidate.artist);
  const confidence = (artist + title) / 2;
  return {
    artist,
    title,
    confidence,
    accepted:
      artist >= thresholds.artist &&
      title >= thresholds.title &&
      confidence >= thresholds.confidence,
  };
}

/**
 * A record and the 7" cut from it share an artist, a title and usually a year,
 * so text similarity cannot separate them at all. Jayme Marques' "¡Que Cosa Mas
 * Linda!" is both a Venezuelan LP and a Spanish 7", every candidate scores 1.0,
 * and Discogs returns the 7" first. Popularity does not help either — the 7"
 * has 232 copies logged against the LP's none.
 *
 * What does separate them is size, because the input is a photograph of a
 * sleeve and a 12" is what people photograph. So this demotes the 7" formats
 * and leaves everything else alone: `parseItemType` files a 12" maxi-single
 * under "ep", which is why an EP must not be ranked below an album. Patrick
 * Cowley's "Menergy" is a 12" maxi-single sharing its name with the LP, and
 * ordering albums first picked the wrong one.
 *
 * Within a tier the provider's own ordering stands — sort is stable, and
 * nothing here claims to know better than Discogs which pressing is meant.
 */
const SEVEN_INCH_FORMATS = new Set<ItemType>(["single", "track"]);

function itemTypeRank(itemType: ItemType | undefined): number {
  return itemType && SEVEN_INCH_FORMATS.has(itemType) ? 1 : 0;
}

/**
 * The most credible accepted candidate, or null if none verifies. Ties break
 * towards the candidate whose year is closest to the one asked for — the only
 * thing year is allowed to decide — and then towards the preferred format.
 */
export function pickBest<
  T extends { artist: string; title: string; year?: number | null; itemType?: ItemType },
>(
  query: ReleaseQuery,
  candidates: T[],
  thresholds: MatchThresholds = DEFAULT_THRESHOLDS,
): { candidate: T; score: CandidateScore } | null {
  const accepted = candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(query, candidate, thresholds) }))
    .filter((entry) => entry.score.accepted);
  if (accepted.length === 0) return null;

  accepted.sort((a, b) => {
    if (b.score.confidence !== a.score.confidence) return b.score.confidence - a.score.confidence;
    const byYear =
      yearDistance(query.year, a.candidate.year) - yearDistance(query.year, b.candidate.year);
    if (byYear !== 0) return byYear;
    return itemTypeRank(a.candidate.itemType) - itemTypeRank(b.candidate.itemType);
  });
  return accepted[0];
}

function yearDistance(asked: number | null | undefined, found: number | null | undefined): number {
  if (!asked || !found) return Number.MAX_SAFE_INTEGER;
  return Math.abs(asked - found);
}

// ---------------------------------------------------------------------------
// Resolution (network)
// ---------------------------------------------------------------------------

export interface ResolvedIds {
  musicbrainzReleaseId: string | null;
  musicbrainzReleaseGroupId: string | null;
  musicbrainzArtistId: string | null;
  discogsReleaseId: number | null;
  discogsMasterId: number | null;
  year: number | null;
  label: string | null;
  country: string | null;
  catalogueNumber: string | null;
  confidence: number;
}

/**
 * Mirrors `music_items.resolution_status`.
 *
 * `absent` is terminal — both databases were asked and neither holds the
 * record. `failed` is retryable — at least one request did not complete, so
 * nothing was learned about whether the record exists. Collapsing the two is
 * the mistake that recorded three fixtures as missing from MusicBrainz when
 * their requests had merely been throttled.
 */
export type ResolutionStatus = "matched" | "partial" | "absent" | "failed";

export interface ResolutionOutcome {
  status: ResolutionStatus;
  /** Null only when nothing verified anywhere. */
  ids: ResolvedIds | null;
  /** One entry per provider whose request did not complete. */
  errors: Array<{ provider: "musicbrainz" | "discogs"; message: string }>;
}

export type ProviderResult<T> =
  | { kind: "found"; value: T; confidence: number }
  | { kind: "absent" }
  | { kind: "failed"; message: string }
  // Distinct from "absent": a database that was never asked has said nothing
  // about whether it holds the record. Only the eval's single-provider
  // strategies produce this, but conflating it with absence would credit a
  // Discogs-only run with correctly abstaining on MusicBrainz.
  | { kind: "skipped" };

/** Wraps a provider candidate in the shape `pickBest` compares on. */
interface Scorable<T> {
  artist: string;
  title: string;
  year: number | null;
  itemType: ItemType;
  value: T;
}

/** MusicBrainz dates are "1974", "1974-05" or "1974-05-01" — the year is the useful part. */
function yearFromDate(date: string | null): number | null {
  if (!date) return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isFinite(year) && year > 0 ? year : null;
}

function messageOf(error: unknown): string {
  if (error instanceof DiscogsHttpError || error instanceof MusicBrainzHttpError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Walk a cascade of query variants, returning the first that verifies.
 *
 * The cascade stops on the first transport error rather than falling through
 * to the next variant. A provider that just refused one request is unlikely to
 * answer the next, and an empty result from a failing provider would be
 * indistinguishable from a genuine absence.
 */
async function runCascade<Query, Candidate>(
  query: ReleaseQuery,
  variants: Query[],
  search: (variant: Query) => Promise<Candidate[]>,
  toScorable: (candidate: Candidate) => Scorable<Candidate>,
  thresholds: MatchThresholds,
): Promise<ProviderResult<Candidate>> {
  for (const variant of variants) {
    let candidates: Candidate[];
    try {
      candidates = await search(variant);
    } catch (error) {
      return { kind: "failed", message: messageOf(error) };
    }

    const best = pickBest(query, candidates.map(toScorable), thresholds);
    if (best) {
      return { kind: "found", value: best.candidate.value, confidence: best.score.confidence };
    }
  }
  return { kind: "absent" };
}

function discogsVariants(query: ReleaseQuery, maxVariants: number): DiscogsSearchQuery[] {
  const stripped = stripCreditClause(query.artist);
  const variants: DiscogsSearchQuery[] = [{ artist: query.artist, releaseTitle: query.title }];
  if (stripped && stripped !== query.artist) {
    variants.push({ artist: stripped, releaseTitle: query.title });
  }
  // Free text last: it is the loosest and so the likeliest to return something
  // plausible and wrong, which only local verification then has to reject.
  variants.push({ q: `${query.artist} ${query.title}` });
  return variants.slice(0, maxVariants);
}

function musicbrainzVariants(query: ReleaseQuery, maxVariants: number): MbReleaseSearchQuery[] {
  const stripped = stripCreditClause(query.artist);
  const variants: MbReleaseSearchQuery[] = [
    { artist: query.artist, title: query.title, quoted: true },
  ];
  if (stripped && stripped !== query.artist) {
    variants.push({ artist: stripped, title: query.title, quoted: true });
  }
  variants.push({ artist: query.artist, title: query.title, quoted: false });
  return variants.slice(0, maxVariants);
}

/**
 * Last resort for a record MusicBrainz files under Various Artists: search the
 * title against the Various Artists entity, then confirm the compilation
 * actually contains the act asked for.
 *
 * The confirmation is not optional. Compilation titles collide constantly, and
 * on title alone this returned an unrelated compilation called "Tanga" for
 * Machito's album and "The Plan: You Never Know" for a Determine single — both
 * scored as confident matches, neither containing the artist. Checking the
 * track credits is the only thing that separates a compilation that holds the
 * record from one that merely shares its name.
 *
 * Costs one extra request per surviving candidate, which is why the title has
 * to clear the bar first and why this only runs once the ordinary cascade has
 * come back empty.
 */
async function resolveMusicBrainzCompilation(
  query: ReleaseQuery,
  candidateLimit: number,
): Promise<ProviderResult<MbReleaseCandidate>> {
  let candidates: MbReleaseCandidate[];
  try {
    candidates = await searchReleaseCandidates({
      artist: query.artist,
      title: query.title,
      variousArtists: true,
      limit: candidateLimit,
    });
  } catch (error) {
    return { kind: "failed", message: messageOf(error) };
  }

  const byTitle = candidates
    .map((candidate) => ({ candidate, title: similarity(query.title, candidate.title) }))
    .filter((entry) => entry.title >= VARIOUS_TITLE_MIN)
    .sort((a, b) => b.title - a.title);

  for (const { candidate, title } of byTitle) {
    let contributors: string[];
    try {
      contributors = await fetchReleaseTrackArtists(candidate.id);
    } catch (error) {
      return { kind: "failed", message: messageOf(error) };
    }
    const credited = contributors.some(
      (name) => artistSimilarity(query.artist, name) >= DEFAULT_THRESHOLDS.artist,
    );
    if (credited) return { kind: "found", value: candidate, confidence: title };
  }

  return { kind: "absent" };
}

export interface ResolverOptions {
  /** Query MusicBrainz. Default true. */
  musicbrainz?: boolean;
  /** Query Discogs. Default true. */
  discogs?: boolean;
  /**
   * Cap the query cascade. 1 keeps only the strictest variant — the structured
   * artist/title search — and so measures precision without the recall the
   * looser variants buy.
   */
  maxVariants?: number;
  thresholds?: MatchThresholds;
  /** Candidates requested per query. Five is enough that the right record is
   * present when it exists at all; taking one on faith is what produced every
   * false id in the fixture set. */
  candidateLimit?: number;
  /** Recover a MusicBrainz artist id from a Discogs-only hit. Default true. */
  recoverArtist?: boolean;
}

interface ResolvedOptions {
  musicbrainz: boolean;
  discogs: boolean;
  maxVariants: number;
  thresholds: MatchThresholds;
  candidateLimit: number;
  recoverArtist: boolean;
}

function withDefaults(options: ResolverOptions = {}): ResolvedOptions {
  return {
    musicbrainz: options.musicbrainz ?? true,
    discogs: options.discogs ?? true,
    maxVariants: options.maxVariants ?? Number.MAX_SAFE_INTEGER,
    thresholds: options.thresholds ?? DEFAULT_THRESHOLDS,
    candidateLimit: options.candidateLimit ?? 5,
    recoverArtist: options.recoverArtist ?? true,
  };
}

export function resolveDiscogs(
  query: ReleaseQuery,
  options: ResolverOptions = {},
): Promise<ProviderResult<DiscogsReleaseCandidate>> {
  const resolved = withDefaults(options);
  return runCascade(
    query,
    discogsVariants(query, resolved.maxVariants),
    (variant) => searchReleases(variant, resolved.candidateLimit),
    (c) => ({
      artist: c.artist,
      title: c.title,
      year: c.year,
      itemType: c.itemType,
      value: c,
    }),
    resolved.thresholds,
  );
}

export async function resolveMusicBrainz(
  query: ReleaseQuery,
  options: ResolverOptions = {},
): Promise<ProviderResult<MbReleaseCandidate>> {
  const resolved = withDefaults(options);
  const main = await runCascade(
    query,
    musicbrainzVariants(query, resolved.maxVariants),
    (variant) => searchReleaseCandidates({ ...variant, limit: resolved.candidateLimit }),
    (c) => ({
      artist: c.artistCredit,
      title: c.title,
      year: yearFromDate(c.date),
      itemType: c.itemType,
      value: c,
    }),
    resolved.thresholds,
  );
  if (main.kind !== "absent" || resolved.maxVariants < Number.MAX_SAFE_INTEGER) return main;
  return resolveMusicBrainzCompilation(query, resolved.candidateLimit);
}

/** A recovered artist must clear the same bar as an artist read off a release. */
const MIN_RECOVERED_ARTIST_SIMILARITY = 0.85;

/**
 * Find a MusicBrainz artist id for a record MusicBrainz has no release for.
 *
 * Worth doing because the MusicBrainz-keyed features are mostly artist-keyed:
 * watch baselines and release alerts both work from an artist MBID, so they
 * keep working for a row whose release only exists in Discogs.
 *
 * Both guards are needed. `pickArtistFromSearch` demands a high MB score and a
 * clear margin over the runner-up, which rejects genuine ambiguity — but MB
 * artist search also returns unambiguous nonsense, matching "Pacho" to a
 * German rapper at score 100 when the record was by Pacho Alonso. Only the
 * name comparison catches that.
 */
export async function recoverMusicBrainzArtistId(artistName: string): Promise<string | null> {
  let candidates: MbArtistCandidate[];
  try {
    candidates = await searchArtistCandidates(artistName);
  } catch {
    // Best-effort: the release ids are already resolved and worth keeping, and
    // the artist id can be filled in by a later sweep.
    return null;
  }

  const picked = pickArtistFromSearch(candidates);
  if (!picked.mbid) return null;

  const chosen = candidates.find((candidate) => candidate.id === picked.mbid);
  if (!chosen) return null;
  if (artistSimilarity(artistName, chosen.name) < MIN_RECOVERED_ARTIST_SIMILARITY) return null;

  return picked.mbid;
}

/**
 * Resolve a hand-written artist and title to catalogue identifiers.
 *
 * Queries both databases by default — see the note at the top of the file for
 * why recall is not the reason MusicBrainz is asked. `options` exists so the
 * resolution eval can run one database at a time and vary the thresholds; the
 * app should take the defaults.
 */
export async function resolveRelease(
  query: ReleaseQuery,
  options: ResolverOptions = {},
): Promise<ResolutionOutcome> {
  const resolved = withDefaults(options);

  // Sequential, not concurrent. Each provider has its own single-slot request
  // gate, so overlapping them wins nothing, and running them in order keeps a
  // failure attributable to one provider.
  const discogs: ProviderResult<DiscogsReleaseCandidate> = resolved.discogs
    ? await resolveDiscogs(query, options)
    : { kind: "skipped" };
  const musicbrainz: ProviderResult<MbReleaseCandidate> = resolved.musicbrainz
    ? await resolveMusicBrainz(query, options)
    : { kind: "skipped" };

  const errors: ResolutionOutcome["errors"] = [];
  if (discogs.kind === "failed") errors.push({ provider: "discogs", message: discogs.message });
  if (musicbrainz.kind === "failed") {
    errors.push({ provider: "musicbrainz", message: musicbrainz.message });
  }

  const dc = discogs.kind === "found" ? discogs.value : null;
  const mb = musicbrainz.kind === "found" ? musicbrainz.value : null;

  if (!dc && !mb) {
    return { status: errors.length > 0 ? "failed" : "absent", ids: null, errors };
  }

  // Only worth a request when Discogs supplied a name MusicBrainz has not
  // already given us an artist id for.
  const musicbrainzArtistId =
    mb?.artistId ??
    (dc && resolved.recoverArtist ? await recoverMusicBrainzArtistId(dc.artist) : null);

  const ids: ResolvedIds = {
    musicbrainzReleaseId: mb?.id ?? null,
    musicbrainzReleaseGroupId: mb?.releaseGroupId ?? null,
    musicbrainzArtistId,
    discogsReleaseId: dc?.releaseId ?? null,
    discogsMasterId: dc?.masterId ?? null,
    // Discogs first for the descriptive fields: on this catalogue it holds the
    // regional pressings, and so the label and catalogue number actually
    // printed on the sleeve in hand.
    year: dc?.year ?? yearFromDate(mb?.date ?? null),
    label: dc?.label ?? mb?.label ?? null,
    country: dc?.country ?? mb?.country ?? null,
    catalogueNumber: dc?.catalogueNumber ?? mb?.catalogueNumber ?? null,
    confidence: Math.max(
      discogs.kind === "found" ? discogs.confidence : 0,
      musicbrainz.kind === "found" ? musicbrainz.confidence : 0,
    ),
  };

  // A provider that errored has not told us the record is missing, so the row
  // stays retryable even though the other provider answered.
  if (errors.length > 0) return { status: "failed", ids, errors };

  // A skipped provider is not a shortfall — a Discogs-only configuration that
  // found the record has done everything it was asked to.
  const asked = [discogs, musicbrainz].filter((result) => result.kind !== "skipped");
  const allFound = asked.every((result) => result.kind === "found");
  return { status: allFound ? "matched" : "partial", ids, errors };
}

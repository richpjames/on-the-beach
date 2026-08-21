import {
  DiscogsHttpError,
  searchReleases,
  type DiscogsReleaseCandidate,
  type DiscogsSearchQuery,
} from "./discogs";
import {
  MusicBrainzHttpError,
  searchArtistCandidates,
  searchReleaseCandidates,
  type MbArtistCandidate,
  type MbReleaseCandidate,
  type MbReleaseSearchQuery,
} from "./musicbrainz";
import { pickArtistFromSearch } from "./artist-identity";
import { editDistance } from "./title-similarity";

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
  const match = /\s+(?:y|e|con|and|with|feat\.?|featuring|presents|pres\.?|vs\.?|&|\+)\s+/i.exec(
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
  const raw =
    allowContainment &&
    shorter.length >= MIN_CONTAINMENT_LENGTH &&
    (longer.startsWith(`${shorter} `) ||
      longer.endsWith(` ${shorter}`) ||
      longer.includes(` ${shorter} `))
      ? CONTAINMENT_SIMILARITY
      : 1 - editDistance(na, nb) / longer.length;

  if (digitSignature(na) !== digitSignature(nb)) return Math.min(raw, DIGIT_MISMATCH_CEILING);
  return raw;
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
  let best = 0;
  for (const left of askedVariants) {
    for (const right of candidateVariants) {
      best = Math.max(best, similarity(left, right, false));
    }
  }
  return best;
}

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

/**
 * Neither field may be weak on its own. A right artist with a wrong title is a
 * different record by the same act; a right title with a wrong artist is one
 * of the hundreds of unrelated records sharing a common title.
 */
const MIN_ARTIST_SIMILARITY = 0.72;
const MIN_TITLE_SIMILARITY = 0.72;
/** …and their mean must clear this, so two barely-passing halves still fail. */
const MIN_CONFIDENCE = 0.82;

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
): CandidateScore {
  const artist = artistSimilarity(query.artist, candidate.artist);
  const title = similarity(query.title, candidate.title);
  const confidence = (artist + title) / 2;
  return {
    artist,
    title,
    confidence,
    accepted:
      artist >= MIN_ARTIST_SIMILARITY &&
      title >= MIN_TITLE_SIMILARITY &&
      confidence >= MIN_CONFIDENCE,
  };
}

/**
 * The most credible accepted candidate, or null if none verifies. Ties break
 * towards the candidate whose year is closest to the one asked for, which is
 * the only thing year is allowed to decide.
 */
export function pickBest<T extends { artist: string; title: string; year?: number | null }>(
  query: ReleaseQuery,
  candidates: T[],
): { candidate: T; score: CandidateScore } | null {
  const accepted = candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(query, candidate) }))
    .filter((entry) => entry.score.accepted);
  if (accepted.length === 0) return null;

  accepted.sort((a, b) => {
    if (b.score.confidence !== a.score.confidence) return b.score.confidence - a.score.confidence;
    return yearDistance(query.year, a.candidate.year) - yearDistance(query.year, b.candidate.year);
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

type ProviderResult<T> =
  | { kind: "found"; value: T; confidence: number }
  | { kind: "absent" }
  | { kind: "failed"; message: string };

/** Wraps a provider candidate in the shape `pickBest` compares on. */
interface Scorable<T> {
  artist: string;
  title: string;
  year: number | null;
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
): Promise<ProviderResult<Candidate>> {
  for (const variant of variants) {
    let candidates: Candidate[];
    try {
      candidates = await search(variant);
    } catch (error) {
      return { kind: "failed", message: messageOf(error) };
    }

    const best = pickBest(query, candidates.map(toScorable));
    if (best) {
      return { kind: "found", value: best.candidate.value, confidence: best.score.confidence };
    }
  }
  return { kind: "absent" };
}

function discogsVariants(query: ReleaseQuery): DiscogsSearchQuery[] {
  const stripped = stripCreditClause(query.artist);
  const variants: DiscogsSearchQuery[] = [{ artist: query.artist, releaseTitle: query.title }];
  if (stripped && stripped !== query.artist) {
    variants.push({ artist: stripped, releaseTitle: query.title });
  }
  // Free text last: it is the loosest and so the likeliest to return something
  // plausible and wrong, which only local verification then has to reject.
  variants.push({ q: `${query.artist} ${query.title}` });
  return variants;
}

function musicbrainzVariants(query: ReleaseQuery): MbReleaseSearchQuery[] {
  const stripped = stripCreditClause(query.artist);
  const variants: MbReleaseSearchQuery[] = [
    { artist: query.artist, title: query.title, quoted: true },
  ];
  if (stripped && stripped !== query.artist) {
    variants.push({ artist: stripped, title: query.title, quoted: true });
  }
  variants.push({ artist: query.artist, title: query.title, quoted: false });
  return variants;
}

export function resolveDiscogs(
  query: ReleaseQuery,
): Promise<ProviderResult<DiscogsReleaseCandidate>> {
  return runCascade(
    query,
    discogsVariants(query),
    (variant) => searchReleases(variant),
    (c) => ({
      artist: c.artist,
      title: c.title,
      year: c.year,
      value: c,
    }),
  );
}

export function resolveMusicBrainz(
  query: ReleaseQuery,
): Promise<ProviderResult<MbReleaseCandidate>> {
  return runCascade(
    query,
    musicbrainzVariants(query),
    (variant) => searchReleaseCandidates(variant),
    (c) => ({ artist: c.artistCredit, title: c.title, year: yearFromDate(c.date), value: c }),
  );
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
 * Queries both databases every time — see the note at the top of the file for
 * why recall is not the reason MusicBrainz is asked.
 */
export async function resolveRelease(query: ReleaseQuery): Promise<ResolutionOutcome> {
  const [discogs, musicbrainz] = [await resolveDiscogs(query), await resolveMusicBrainz(query)];

  const errors: ResolutionOutcome["errors"] = [];
  if (discogs.kind === "failed") errors.push({ provider: "discogs", message: discogs.message });
  if (musicbrainz.kind === "failed") {
    errors.push({ provider: "musicbrainz", message: musicbrainz.message });
  }

  const found = discogs.kind === "found" || musicbrainz.kind === "found";
  if (!found) {
    return { status: errors.length > 0 ? "failed" : "absent", ids: null, errors };
  }

  const dc = discogs.kind === "found" ? discogs.value : null;
  const mb = musicbrainz.kind === "found" ? musicbrainz.value : null;

  // Only worth a request when Discogs supplied a name MusicBrainz has not
  // already given us an artist id for.
  const musicbrainzArtistId =
    mb?.artistId ?? (dc ? await recoverMusicBrainzArtistId(dc.artist) : null);

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
  return { status: dc && mb ? "matched" : "partial", ids, errors };
}

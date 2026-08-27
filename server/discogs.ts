import type { ItemType } from "../src/types";

const DISCOGS_API_BASE = "https://api.discogs.com";
const USER_AGENT = "on-the-beach/1.0 (https://github.com/richpjames/on-the-beach)";

/** A non-2xx response from Discogs, carrying the status for backoff decisions. */
export class DiscogsHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "DiscogsHttpError";
    this.status = status;
  }
}

/**
 * A Discogs personal access token. `DISCOGS_PAT` names what it actually is and
 * is the preferred variable; `DISCOGS_TOKEN` is still read so existing
 * deployments keep working.
 */
function discogsToken(): string | undefined {
  return process.env.DISCOGS_PAT ?? process.env.DISCOGS_TOKEN;
}

function discogsHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  };
  const token = discogsToken();
  if (token) headers["Authorization"] = `Discogs token=${token}`;
  return headers;
}

// ---------------------------------------------------------------------------
// Shared request gate
//
// Discogs allows 60 requests/minute authenticated and 25 unauthenticated. As
// with MusicBrainz (see the gate in server/musicbrainz.ts), several callers now
// compete for that budget — release resolution during a scan, and any backfill
// sweep over existing rows. A per-caller throttle only paces itself; run
// concurrently they quietly multiply the rate and earn a 429. Every outbound
// Discogs request passes through this single serialising gate so the process as
// a whole stays inside the limit, whichever caller is asking.
// ---------------------------------------------------------------------------

function minRequestGapMs(): number {
  const fromEnv = Number(process.env.OTB_DISCOGS_MIN_REQUEST_GAP_MS);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
  // 60/min with a token, 25/min without, each with a little headroom.
  return discogsToken() ? 1_050 : 2_500;
}

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

let gateTail: Promise<void> = Promise.resolve();

const DISCOGS_FETCH_TIMEOUT_MS = 15_000;

function discogsFetch(url: string, timeoutMs = DISCOGS_FETCH_TIMEOUT_MS): Promise<Response> {
  const gap = minRequestGapMs();
  const turn = gateTail.then(() =>
    fetch(url, { headers: discogsHeaders(), signal: AbortSignal.timeout(timeoutMs) }),
  );
  // The next caller waits for this request to finish plus the minimum gap.
  // Failures must not wedge the queue, so the tail swallows them — the
  // rejection is still delivered to the caller through `turn`.
  gateTail = turn.then(
    () => sleep(gap),
    () => sleep(gap),
  );
  return turn;
}

interface DiscogsArtist {
  name?: unknown;
}

interface DiscogsImage {
  type?: unknown;
  uri?: unknown;
}

interface DiscogsFormat {
  name?: unknown;
  descriptions?: unknown;
}

interface DiscogsRelease {
  title?: unknown;
  year?: unknown;
  artists?: unknown;
  genres?: unknown;
  styles?: unknown;
  images?: unknown;
  formats?: unknown;
}

export interface DiscogsScrapedData {
  potentialTitle?: string;
  potentialArtist?: string;
  imageUrl?: string;
  itemType: ItemType;
  year?: number;
  genre?: string;
}

function parseArtistName(artists: unknown): string | undefined {
  if (!Array.isArray(artists) || artists.length === 0) return undefined;
  const first = artists[0] as DiscogsArtist;
  if (typeof first?.name !== "string") return undefined;
  // Remove Discogs disambiguation suffix like " (2)"
  return first.name.replace(/\s+\(\d+\)$/, "").trim() || undefined;
}

function parsePrimaryGenre(genres: unknown, styles: unknown): string | undefined {
  const styleList = Array.isArray(styles)
    ? styles.filter((s): s is string => typeof s === "string")
    : [];
  const genreList = Array.isArray(genres)
    ? genres.filter((g): g is string => typeof g === "string")
    : [];
  return styleList[0] ?? genreList[0] ?? undefined;
}

function parsePrimaryImageUri(images: unknown): string | undefined {
  if (!Array.isArray(images) || images.length === 0) return undefined;
  const primary = images.find((img) => (img as DiscogsImage).type === "primary") ?? images[0];
  const uri = (primary as DiscogsImage).uri;
  return typeof uri === "string" ? uri : undefined;
}

function parseYear(year: unknown): number | undefined {
  const num = typeof year === "number" ? year : typeof year === "string" ? parseInt(year, 10) : NaN;
  return Number.isFinite(num) && num > 0 ? num : undefined;
}

function parseItemType(formats: unknown): ItemType {
  if (!Array.isArray(formats) || formats.length === 0) return "album";

  const first = formats[0] as DiscogsFormat;
  const descriptions = Array.isArray(first.descriptions)
    ? first.descriptions.filter((d): d is string => typeof d === "string")
    : [];
  const formatName = typeof first.name === "string" ? first.name.toLowerCase() : "";
  const allTerms = [...descriptions.map((d) => d.toLowerCase()), formatName];

  if (allTerms.some((t) => t === "single" || t === '7"')) return "single";
  if (allTerms.some((t) => t === "ep" || t === '12"' || t === "mini-album")) return "ep";
  if (allTerms.some((t) => t === "compilation")) return "compilation";
  if (allTerms.some((t) => t === "mixtape")) return "mix";

  return "album";
}

function extractDiscogsTypeAndId(
  url: string,
): { type: "release" | "master" | "listing"; id: string } | null {
  // /sell/item/<id> is the legacy spelling of /shop/item/<id>; same listing id.
  const listingMatch = url.match(/discogs\.com\/(?:sell|shop)\/item\/(\d+)/);
  if (listingMatch) return { type: "listing", id: listingMatch[1] };
  const match = url.match(/discogs\.com\/(release|master)\/(\d+)/);
  if (!match) return null;
  return { type: match[1] as "release" | "master", id: match[2] };
}

export function parseDiscogsRelease(data: unknown): DiscogsScrapedData | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;

  const release = data as DiscogsRelease;

  const potentialTitle =
    typeof release.title === "string" ? release.title.trim() || undefined : undefined;
  const potentialArtist = parseArtistName(release.artists);
  const year = parseYear(release.year);
  const genre = parsePrimaryGenre(release.genres, release.styles);
  const imageUrl = parsePrimaryImageUri(release.images);
  const itemType = parseItemType(release.formats);

  if (!potentialTitle && !potentialArtist && !imageUrl) return null;

  return {
    potentialTitle,
    potentialArtist,
    imageUrl,
    itemType,
    ...(year !== undefined ? { year } : {}),
    ...(genre !== undefined ? { genre } : {}),
  };
}

interface DiscogsListing {
  release?: { id?: unknown };
}

async function resolveListingToReleaseId(
  listingId: string,
  timeoutMs: number,
): Promise<string | null> {
  const apiUrl = `${DISCOGS_API_BASE}/marketplace/listings/${listingId}`;
  try {
    const response = await discogsFetch(apiUrl, timeoutMs);
    if (!response.ok) return null;
    const data = (await response.json()) as DiscogsListing;
    const releaseId = data?.release?.id;
    return typeof releaseId === "number" ? String(releaseId) : null;
  } catch {
    return null;
  }
}

export async function fetchDiscogsRelease(
  url: string,
  timeoutMs: number,
): Promise<DiscogsScrapedData | null> {
  const info = extractDiscogsTypeAndId(url);
  if (!info) return null;

  let endpoint: string;
  let id: string;

  if (info.type === "listing") {
    const releaseId = await resolveListingToReleaseId(info.id, timeoutMs);
    if (!releaseId) {
      console.warn(`[discogs] Could not resolve listing ${info.id} to a release`);
      return null;
    }
    endpoint = "releases";
    id = releaseId;
  } else {
    endpoint = info.type === "master" ? "masters" : "releases";
    id = info.id;
  }

  const apiUrl = `${DISCOGS_API_BASE}/${endpoint}/${id}`;

  try {
    const response = await discogsFetch(apiUrl, timeoutMs);

    if (!response.ok) {
      console.warn(`[discogs] API returned ${response.status} for ${apiUrl}`);
      return null;
    }

    const data = (await response.json()) as unknown;
    return parseDiscogsRelease(data);
  } catch (err) {
    console.error("[discogs] Fetch failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Release search
//
// Used to resolve an artist/title pair to a Discogs identifier. Discogs is the
// higher-recall source for this catalogue — over the eval fixture set it
// resolved every record MusicBrainz did plus 44 more, mostly regional Latin
// American and Iberian pressings — so it is queried first, not as a fallback.
// ---------------------------------------------------------------------------

/** A candidate from `/database/search`. Callers MUST verify before accepting. */
export interface DiscogsReleaseCandidate {
  releaseId: number;
  /**
   * The work-level identity. `null` when Discogs has no master for the release,
   * which is common for one-off pressings — roughly a sixth of the eval fixture
   * set. Treat `null` as "the release id IS the identity", never as a gap.
   */
  masterId: number | null;
  artist: string;
  title: string;
  year: number | null;
  country: string | null;
  label: string | null;
  catalogueNumber: string | null;
}

export interface DiscogsSearchQuery {
  artist?: string;
  releaseTitle?: string;
  /** Searching by a track name printed on the sleeve is often decisive. */
  track?: string;
  /** A legible catalogue number is the single strongest signal available. */
  catno?: string;
  /** Free text, for when the structured fields return nothing. */
  q?: string;
}

interface DiscogsSearchResult {
  id?: unknown;
  master_id?: unknown;
  title?: unknown;
  year?: unknown;
  country?: unknown;
  label?: unknown;
  catno?: unknown;
}

/**
 * Search results pack "Artist - Title" into a single `title` field, so it has
 * to be split back apart. The artist half carries Discogs' disambiguation
 * suffix for duplicate names ("Bana (2)"), stripped here the same way
 * `parseArtistName` strips it from a full release document.
 */
function splitSearchTitle(raw: string): { artist: string; title: string } {
  const separator = raw.indexOf(" - ");
  if (separator === -1) return { artist: "", title: raw.trim() };
  return {
    artist: raw
      .slice(0, separator)
      .replace(/\s+\(\d+\)$/, "")
      .trim(),
    title: raw.slice(separator + 3).trim(),
  };
}

function parseSearchResult(raw: unknown): DiscogsReleaseCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  const result = raw as DiscogsSearchResult;
  if (typeof result.id !== "number") return null;

  const { artist, title } = splitSearchTitle(typeof result.title === "string" ? result.title : "");
  // Discogs reports "no master" as 0, not null. Left as 0 it looks like a valid
  // id; coerced to null it is unambiguous.
  const masterId =
    typeof result.master_id === "number" && result.master_id > 0 ? result.master_id : null;

  return {
    releaseId: result.id,
    masterId,
    artist,
    title,
    year: parseYear(result.year) ?? null,
    country: typeof result.country === "string" ? result.country : null,
    label:
      Array.isArray(result.label) && typeof result.label[0] === "string" ? result.label[0] : null,
    catalogueNumber: typeof result.catno === "string" ? result.catno : null,
  };
}

/**
 * Search Discogs releases. Returns up to `limit` candidates ranked by Discogs'
 * own relevance.
 *
 * That ranking is NOT a confidence signal — Discogs, like MusicBrainz, returns
 * a confident top hit for queries describing records it does not hold. Callers
 * must compare each candidate's artist and title against what they were looking
 * for and abstain when nothing verifies. This is why the function returns a
 * list rather than a single best answer.
 *
 * Throws `DiscogsHttpError` on a non-2xx response and the underlying error on a
 * network failure, so callers can tell "no such record" apart from "the lookup
 * failed". Returning null for both is what made an earlier pass record three
 * fixtures as absent when the requests had in fact been throttled.
 */
export async function searchReleases(
  query: DiscogsSearchQuery,
  limit = 5,
): Promise<DiscogsReleaseCandidate[]> {
  const params = new URLSearchParams({ type: "release", per_page: String(limit) });
  if (query.artist) params.set("artist", query.artist);
  if (query.releaseTitle) params.set("release_title", query.releaseTitle);
  if (query.track) params.set("track", query.track);
  if (query.catno) params.set("catno", query.catno);
  if (query.q) params.set("q", query.q);

  const url = `${DISCOGS_API_BASE}/database/search?${params}`;
  const response = await discogsFetch(url);

  if (!response.ok) {
    throw new DiscogsHttpError(
      response.status,
      `Discogs search returned ${response.status} for ${JSON.stringify(query)}`,
    );
  }

  const data = (await response.json()) as { results?: unknown[] };
  const raw = Array.isArray(data.results) ? data.results : [];
  return raw.flatMap((entry) => {
    const parsed = parseSearchResult(entry);
    return parsed ? [parsed] : [];
  });
}

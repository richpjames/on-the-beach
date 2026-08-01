import type { ReleaseLengthPreference } from "./settings";
import { titleMatchesAny } from "./title-similarity";

const MB_API_BASE = "https://musicbrainz.org/ws/2";
// MusicBrainz requires a User-Agent identifying the app with contact info —
// placeholder/generic UAs get throttled or blocked (403/503).
const USER_AGENT = "on-the-beach/1.0 (https://github.com/richpjames/on-the-beach)";

/** A non-2xx response from MusicBrainz, carrying the status for backoff decisions. */
export class MusicBrainzHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "MusicBrainzHttpError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Shared request gate
//
// MusicBrainz allows roughly one request per second per client. Two background
// sweeps now compete for that budget (the suggestion prefetch and the artist
// release watcher), and each sweep's own throttle only paces itself — run
// concurrently they quietly double the rate and earn a 503. Every outbound MB
// request passes through this single serialising gate so the process as a
// whole stays inside the limit, whichever caller is asking.
// ---------------------------------------------------------------------------

function minRequestGapMs(): number {
  const fromEnv = Number(process.env.OTB_MB_MIN_REQUEST_GAP_MS);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : 1_100;
}

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

let gateTail: Promise<void> = Promise.resolve();

// A wedged MusicBrainz connection would otherwise hang callers indefinitely —
// fetch has no default timeout — and, worse, hold the gate shut for everyone
// queued behind it.
const MB_FETCH_TIMEOUT_MS = 15_000;

function mbFetch(url: string): Promise<Response> {
  const gap = minRequestGapMs();
  const turn = gateTail.then(() =>
    fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(MB_FETCH_TIMEOUT_MS),
    }),
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

export interface MusicBrainzFields {
  year: number | null;
  label: string | null;
  country: string | null;
  catalogueNumber: string | null;
  musicbrainzReleaseId: string | null;
  musicbrainzArtistId: string | null;
}

interface MbLabelInfo {
  "catalog-number"?: unknown;
  label?: { name?: unknown };
}

interface MbArtistCredit {
  artist?: { id?: unknown };
}

interface MbRelease {
  id?: unknown;
  date?: unknown;
  country?: unknown;
  "label-info"?: unknown;
  "artist-credit"?: unknown;
}

interface MbSearchResponse {
  releases?: unknown[];
}

function parseYear(date: unknown): number | null {
  if (typeof date !== "string" || date.length < 4) return null;
  const year = parseInt(date.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

function parseLabelInfo(labelInfo: unknown): {
  label: string | null;
  catalogueNumber: string | null;
} {
  if (!Array.isArray(labelInfo) || labelInfo.length === 0) {
    return { label: null, catalogueNumber: null };
  }

  const first = labelInfo[0] as MbLabelInfo;
  const label = first.label && typeof first.label.name === "string" ? first.label.name : null;
  const catalogueNumber =
    typeof first["catalog-number"] === "string" ? first["catalog-number"] : null;

  return { label, catalogueNumber };
}

export interface SuggestedRelease {
  title: string;
  itemType: string;
  year: number | null;
  musicbrainzReleaseId: string | null;
}

interface MbArtistRelease {
  id?: unknown;
  title?: unknown;
  date?: unknown;
  "primary-type"?: unknown;
  media?: unknown;
}

/** Total track count across a release's media, or null when MB has no data. */
function parseTrackCount(media: unknown): number | null {
  if (!Array.isArray(media) || media.length === 0) return null;
  let total = 0;
  let found = false;
  for (const medium of media) {
    const count = (medium as { "track-count"?: unknown })["track-count"];
    if (typeof count === "number" && Number.isFinite(count)) {
      total += count;
      found = true;
    }
  }
  return found ? total : null;
}

// Track-count buckets standing in for release length: MB's artist releases
// don't carry durations or release-group primary types, so track count is the
// best available proxy for album vs EP vs single.
type LengthBucket = "long" | "medium" | "short" | "unknown";

function lengthBucket(trackCount: number | null): LengthBucket {
  if (trackCount === null) return "unknown";
  if (trackCount >= 7) return "long";
  if (trackCount >= 3) return "medium";
  return "short";
}

/**
 * Rank of a release's length bucket under the user's preference — lower is
 * better. Unknown lengths always rank last so a release MB has no media data
 * for never beats one we can actually size.
 */
function lengthRank(trackCount: number | null, preference: ReleaseLengthPreference): number {
  const order: LengthBucket[] =
    preference === "shorter"
      ? ["short", "medium", "long", "unknown"]
      : ["long", "medium", "short", "unknown"];
  return order.indexOf(lengthBucket(trackCount));
}

interface MbArtistReleasesResponse {
  releases?: unknown[];
}

interface MbArtistSearchResponse {
  artists?: Array<{ id?: unknown }>;
}

async function fetchArtistMbid(artistName: string): Promise<string | null> {
  const params = new URLSearchParams({ query: artistName, limit: "1", fmt: "json" });
  const url = `${MB_API_BASE}/artist?${params}`;
  const response = await mbFetch(url);
  if (!response.ok) {
    throw new MusicBrainzHttpError(
      response.status,
      `MusicBrainz artist search returned ${response.status} for "${artistName}"`,
    );
  }
  const data = (await response.json()) as MbArtistSearchResponse;
  const first = data.artists?.[0];
  return typeof first?.id === "string" ? first.id : null;
}

async function fetchArtistReleases(mbid: string): Promise<MbArtistRelease[]> {
  // `media` rides along so each release carries its track counts — the
  // release-length preference needs them to rank candidates.
  const params = new URLSearchParams({ inc: "releases+media", fmt: "json" });
  const url = `${MB_API_BASE}/artist/${mbid}?${params}`;
  const response = await mbFetch(url);
  if (!response.ok) {
    throw new MusicBrainzHttpError(
      response.status,
      `MusicBrainz artist lookup returned ${response.status} for ${mbid}`,
    );
  }
  const data = (await response.json()) as MbArtistReleasesResponse;
  return Array.isArray(data.releases) ? (data.releases as MbArtistRelease[]) : [];
}

/**
 * Find another release by the artist whose title neither matches nor is close
 * to anything in `trackedTitles`. Candidates are ranked by release length
 * under `lengthPreference` (albums before EPs before singles by default,
 * reversed for "shorter"), then by year: closest to `sourceYear`, or most
 * recent when null.
 *
 * Returns null when the artist can't be found or has no untracked releases.
 * Network failures and non-2xx MusicBrainz responses THROW so callers can
 * tell "nothing to suggest" apart from "the lookup failed" — swallowing them
 * here made production failures (rate limiting, blocked UAs) invisible.
 */
export async function findSuggestedRelease(opts: {
  mbArtistId: string | null;
  artistName: string;
  trackedTitles: Set<string>;
  sourceYear: number | null;
  lengthPreference?: ReleaseLengthPreference;
}): Promise<SuggestedRelease | null> {
  const { mbArtistId, artistName, trackedTitles, sourceYear, lengthPreference = "longer" } = opts;
  const searchLog = { artistName, mbArtistId, sourceYear, lengthPreference };

  const mbid = mbArtistId ?? (await fetchArtistMbid(artistName));
  if (!mbid) {
    console.info("[musicbrainz] No artist match for suggestion lookup", searchLog);
    return null;
  }

  const releases = await fetchArtistReleases(mbid);
  const candidates = releases.filter((r) => {
    if (typeof r.title !== "string" || !r.title) return false;
    // Exact match on the normalized set first (cheap), then the fuzzy pass so
    // "Amber (Deluxe Edition)" doesn't slip past a library that has "Amber".
    if (trackedTitles.has(r.title.toLowerCase().trim())) return false;
    return !titleMatchesAny(r.title, trackedTitles);
  });

  if (candidates.length === 0) {
    console.info("[musicbrainz] No suggestible releases", {
      ...searchLog,
      mbid,
      releaseCount: releases.length,
      trackedCount: trackedTitles.size,
    });
    return null;
  }

  const ranked = candidates.map((r) => ({
    title: r.title as string,
    year: parseYear(r.date),
    trackCount: parseTrackCount(r.media),
    musicbrainzReleaseId: typeof r.id === "string" ? r.id : null,
    itemType: typeof r["primary-type"] === "string" ? r["primary-type"].toLowerCase() : "album",
  }));

  const byYear = (a: { year: number | null }, b: { year: number | null }): number => {
    if (sourceYear === null) {
      // Most recent first; undated releases last.
      return (b.year ?? -Infinity) - (a.year ?? -Infinity);
    }
    // Closest in year to the source release; undated releases last rather
    // than treated as a perfect match.
    const distance = (year: number | null) =>
      year === null ? Number.MAX_SAFE_INTEGER : Math.abs(year - sourceYear);
    return distance(a.year) - distance(b.year);
  };

  ranked.sort(
    (a, b) =>
      lengthRank(a.trackCount, lengthPreference) - lengthRank(b.trackCount, lengthPreference) ||
      byYear(a, b),
  );

  const picked = ranked[0] ?? null;
  console.info("[musicbrainz] Suggestion lookup result", {
    ...searchLog,
    mbid,
    releaseCount: releases.length,
    candidateCount: candidates.length,
    picked: picked ? { title: picked.title, year: picked.year, tracks: picked.trackCount } : null,
  });

  return picked;
}

// ---------------------------------------------------------------------------
// Release groups (artist watch)
//
// The suggestion path above browses *releases* because it needs `media` track
// counts to size a record. The watcher needs the opposite grain: release
// **groups** are the album-level entity, one per work, so a 2026 Japanese
// repress of a 1974 album doesn't read as a new record. The two paths coexist.
// ---------------------------------------------------------------------------

export interface MbReleaseGroup {
  id: string;
  title: string;
  primaryType: string | null;
  secondaryTypes: string[];
  /** MB's date verbatim: "1974", "1974-05" and "1974-05-01" are all possible. */
  firstReleaseDate: string | null;
}

interface MbReleaseGroupResponse {
  "release-groups"?: unknown[];
  "release-group-count"?: unknown;
}

const RELEASE_GROUP_PAGE_SIZE = 100;
// Even Sun Ra tops out well short of 1,000 release groups; the cap stops a
// malformed count from looping the sweep forever.
const RELEASE_GROUP_MAX_PAGES = 10;

function parseReleaseGroup(raw: unknown): MbReleaseGroup | null {
  if (!raw || typeof raw !== "object") return null;
  const group = raw as Record<string, unknown>;
  if (typeof group.id !== "string" || typeof group.title !== "string") return null;

  const secondary = Array.isArray(group["secondary-types"])
    ? group["secondary-types"].filter((t): t is string => typeof t === "string")
    : [];

  return {
    id: group.id,
    title: group.title,
    primaryType: typeof group["primary-type"] === "string" ? group["primary-type"] : null,
    secondaryTypes: secondary,
    firstReleaseDate:
      typeof group["first-release-date"] === "string" && group["first-release-date"].length > 0
        ? group["first-release-date"]
        : null,
  };
}

/**
 * Every release group credited to an artist. Paginates only when a page comes
 * back full — one request covers all but the most prolific artists.
 *
 * Throws `MusicBrainzHttpError` on a non-2xx response and the underlying error
 * on a network failure: the caller has to tell "no releases" apart from "the
 * lookup failed", because writing a baseline from a partial fetch would make
 * every missing group alert as new on the next successful poll.
 */
export async function fetchArtistReleaseGroups(mbid: string): Promise<MbReleaseGroup[]> {
  const groups: MbReleaseGroup[] = [];

  for (let page = 0; page < RELEASE_GROUP_MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      artist: mbid,
      limit: String(RELEASE_GROUP_PAGE_SIZE),
      offset: String(page * RELEASE_GROUP_PAGE_SIZE),
      fmt: "json",
    });
    const response = await mbFetch(`${MB_API_BASE}/release-group?${params}`);
    if (!response.ok) {
      throw new MusicBrainzHttpError(
        response.status,
        `MusicBrainz release-group browse returned ${response.status} for ${mbid}`,
      );
    }

    const data = (await response.json()) as MbReleaseGroupResponse;
    const raw = Array.isArray(data["release-groups"]) ? data["release-groups"] : [];
    for (const entry of raw) {
      const parsed = parseReleaseGroup(entry);
      if (parsed) groups.push(parsed);
    }

    if (raw.length < RELEASE_GROUP_PAGE_SIZE) break;
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Artist search (MBID resolution, last resort)
// ---------------------------------------------------------------------------

export interface MbArtistCandidate {
  id: string;
  name: string;
  score: number;
  /** MB's disambiguation comment — the thing that tells two Nirvanas apart. */
  disambiguation: string | null;
  country: string | null;
  type: string | null;
  lifeSpanBegin: string | null;
  lifeSpanEnd: string | null;
}

interface MbArtistCandidateResponse {
  artists?: unknown[];
}

/**
 * Name-search an artist, returning the ranked candidates with the fields a
 * human needs to disambiguate them. Scoring is left to the caller — see
 * `pickArtistFromSearch` in server/artist-identity.ts.
 */
export async function searchArtistCandidates(
  artistName: string,
  limit = 5,
): Promise<MbArtistCandidate[]> {
  const params = new URLSearchParams({ query: artistName, limit: String(limit), fmt: "json" });
  const response = await mbFetch(`${MB_API_BASE}/artist?${params}`);
  if (!response.ok) {
    throw new MusicBrainzHttpError(
      response.status,
      `MusicBrainz artist search returned ${response.status} for "${artistName}"`,
    );
  }

  const data = (await response.json()) as MbArtistCandidateResponse;
  const raw = Array.isArray(data.artists) ? data.artists : [];

  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const artist = entry as Record<string, unknown>;
    if (typeof artist.id !== "string" || typeof artist.name !== "string") return [];
    const lifeSpan = (artist["life-span"] ?? {}) as Record<string, unknown>;

    return [
      {
        id: artist.id,
        name: artist.name,
        score: typeof artist.score === "number" ? artist.score : 0,
        disambiguation:
          typeof artist.disambiguation === "string" && artist.disambiguation.length > 0
            ? artist.disambiguation
            : null,
        country: typeof artist.country === "string" ? artist.country : null,
        type: typeof artist.type === "string" ? artist.type : null,
        lifeSpanBegin: typeof lifeSpan.begin === "string" ? lifeSpan.begin : null,
        lifeSpanEnd: typeof lifeSpan.end === "string" ? lifeSpan.end : null,
      },
    ];
  });
}

export async function lookupRelease(
  artist: string,
  title: string,
  year?: string,
): Promise<MusicBrainzFields | null> {
  const queryParts = [`artist:${artist}`, `AND release:${title}`];
  if (year) {
    queryParts.push(`AND date:${year}`);
  }
  const query = queryParts.join(" ");
  const params = new URLSearchParams({ query, limit: "1", fmt: "json" });
  const url = `${MB_API_BASE}/release?${params}`;
  const searchLog = {
    artist,
    title,
    year: year ?? null,
    query,
  };

  try {
    console.info("[musicbrainz] Searching releases", searchLog);

    const response = await mbFetch(url);

    if (!response.ok) {
      console.warn(`[musicbrainz] Search returned ${response.status}`, searchLog);
      return null;
    }

    const data = (await response.json()) as MbSearchResponse;
    const releaseCount = Array.isArray(data.releases) ? data.releases.length : 0;

    if (releaseCount === 0) {
      console.info("[musicbrainz] Search returned no releases", searchLog);
      return null;
    }

    const release = data.releases![0] as MbRelease;
    const { label, catalogueNumber } = parseLabelInfo(release["label-info"]);
    const country = typeof release.country === "string" ? release.country : null;
    const artistCredit = Array.isArray(release["artist-credit"]) ? release["artist-credit"] : [];
    const firstCredit = artistCredit[0] as MbArtistCredit | undefined;

    const result = {
      year: parseYear(release.date),
      label,
      country,
      catalogueNumber,
      musicbrainzReleaseId: typeof release.id === "string" ? release.id : null,
      musicbrainzArtistId:
        firstCredit?.artist && typeof firstCredit.artist.id === "string"
          ? firstCredit.artist.id
          : null,
    };

    console.info("[musicbrainz] Search result", {
      ...searchLog,
      releaseCount,
      result,
    });

    return result;
  } catch (err) {
    console.error("[musicbrainz] Lookup failed:", err);
    return null;
  }
}

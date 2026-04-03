const MB_API_BASE = "https://musicbrainz.org/ws/2";
const USER_AGENT = "on-the-beach/1.0 (https://github.com/your-repo)";

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
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as MbArtistSearchResponse;
    const first = data.artists?.[0];
    return typeof first?.id === "string" ? first.id : null;
  } catch {
    return null;
  }
}

async function fetchArtistReleases(mbid: string): Promise<MbArtistRelease[]> {
  const params = new URLSearchParams({ inc: "releases", fmt: "json" });
  const url = `${MB_API_BASE}/artist/${mbid}?${params}`;
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!response.ok) return [];
  const data = (await response.json()) as MbArtistReleasesResponse;
  return Array.isArray(data.releases) ? (data.releases as MbArtistRelease[]) : [];
}

export async function findSuggestedRelease(opts: {
  mbArtistId: string | null;
  artistName: string;
  trackedTitles: Set<string>;
  sourceYear: number | null;
}): Promise<SuggestedRelease | null> {
  const { mbArtistId, artistName, trackedTitles, sourceYear } = opts;

  try {
    const mbid = mbArtistId ?? (await fetchArtistMbid(artistName));
    if (!mbid) return null;

    const releases = await fetchArtistReleases(mbid);
    if (releases.length === 0) return null;

    const candidates = releases.filter((r) => {
      if (typeof r.title !== "string" || !r.title) return false;
      return !trackedTitles.has(r.title.toLowerCase().trim());
    });

    if (candidates.length === 0) return null;

    const withYear = candidates.map((r) => ({
      title: r.title as string,
      year: parseYear(r.date),
      musicbrainzReleaseId: typeof r.id === "string" ? r.id : null,
      itemType: typeof r["primary-type"] === "string" ? r["primary-type"].toLowerCase() : "album",
    }));

    if (sourceYear === null) {
      withYear.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
      return withYear[0] ?? null;
    }

    withYear.sort(
      (a, b) =>
        Math.abs((a.year ?? sourceYear) - sourceYear) -
        Math.abs((b.year ?? sourceYear) - sourceYear),
    );

    return withYear[0] ?? null;
  } catch {
    return null;
  }
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

    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
    });

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

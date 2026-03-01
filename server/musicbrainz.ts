const MB_API_BASE = "https://musicbrainz.org/ws/2";
const USER_AGENT = "on-the-beach/1.0 (https://github.com/your-repo)";

export interface MusicBrainzFields {
  year: number | null;
  label: string | null;
  country: string | null;
  catalogueNumber: string | null;
}

interface MbLabelInfo {
  "catalog-number"?: unknown;
  label?: { name?: unknown };
}

interface MbRelease {
  date?: unknown;
  country?: unknown;
  "label-info"?: unknown;
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

export async function lookupRelease(
  artist: string,
  title: string,
): Promise<MusicBrainzFields | null> {
  const query = `artist:${artist} AND release:${title}`;
  const params = new URLSearchParams({ query, limit: "1", fmt: "json" });
  const url = `${MB_API_BASE}/release?${params}`;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      console.warn(`[musicbrainz] Search returned ${response.status}`);
      return null;
    }

    const data = (await response.json()) as MbSearchResponse;

    if (!Array.isArray(data.releases) || data.releases.length === 0) {
      return null;
    }

    const release = data.releases[0] as MbRelease;
    const { label, catalogueNumber } = parseLabelInfo(release["label-info"]);
    const country = typeof release.country === "string" ? release.country : null;

    return {
      year: parseYear(release.date),
      label,
      country,
      catalogueNumber,
    };
  } catch (err) {
    console.error("[musicbrainz] Lookup failed:", err);
    return null;
  }
}

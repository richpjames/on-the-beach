import type { ItemType } from "../src/types";

const DISCOGS_API_BASE = "https://api.discogs.com";
const USER_AGENT = "on-the-beach/1.0 (https://github.com/richpjames/on-the-beach)";

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
  const primary =
    images.find((img) => (img as DiscogsImage).type === "primary") ?? images[0];
  const uri = (primary as DiscogsImage).uri;
  return typeof uri === "string" ? uri : undefined;
}

function parseYear(year: unknown): number | undefined {
  const num =
    typeof year === "number"
      ? year
      : typeof year === "string"
        ? parseInt(year, 10)
        : NaN;
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
): { type: "release" | "master"; id: string } | null {
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

export async function fetchDiscogsRelease(
  url: string,
  timeoutMs: number,
): Promise<DiscogsScrapedData | null> {
  const info = extractDiscogsTypeAndId(url);
  if (!info) return null;

  const endpoint = info.type === "master" ? "masters" : "releases";
  const apiUrl = `${DISCOGS_API_BASE}/${endpoint}/${info.id}`;

  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  };

  const token = process.env.DISCOGS_TOKEN;
  if (token) {
    headers["Authorization"] = `Discogs token=${token}`;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(apiUrl, { signal: controller.signal, headers });
    clearTimeout(timer);

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

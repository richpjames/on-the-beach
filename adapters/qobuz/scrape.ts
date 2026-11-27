/**
 * Scraping a Qobuz link through the catalogue API.
 *
 * There is no page to scrape: the store sits behind bot protection and the
 * player is an empty client-rendered shell, so the API is the only door.
 * `parseQobuzUrl` lifts the resource kind and id out of either URL form —
 * the store (`www.qobuz.com/{locale}/{kind}/{slug}/{id}`, artists under
 * `interpreter`) or the player (`play.qobuz.com/{kind}/{id}`) — and the
 * matching endpoint (`album/get`, `track/get`, …) supplies the metadata,
 * release date included.
 */
import type { ItemType } from "../../domain/types";
import {
  firstDefined,
  getString,
  hasScrapedMetadata,
  isRecord,
  type ScrapedMetadata,
} from "../web/html-metadata";
import { fetchQobuzApi, qobuzStorefrontUrl } from "./api";

export type QobuzResourceKind = "album" | "track" | "artist" | "playlist";

export interface QobuzResource {
  kind: QobuzResourceKind;
  id: string;
}

const RESOURCE_KINDS = new Set<string>(["album", "track", "artist", "playlist"]);

/** The resource a Qobuz URL names, or null when it names none we model. */
export function parseQobuzUrl(url: string): QobuzResource | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split("/").filter(Boolean);

  // play.qobuz.com/{kind}/{id}
  if (host === "play.qobuz.com") {
    const [kind, id] = segments;
    if (kind && RESOURCE_KINDS.has(kind) && id && /^[a-zA-Z0-9]+$/.test(id)) {
      return { kind: kind as QobuzResourceKind, id };
    }
    return null;
  }

  // www.qobuz.com/{locale}/{kind}/{slug}/{id} — the slug concatenates title
  // and artist, so names come from the API, not the URL. Artists are filed
  // under "interpreter".
  if (host === "qobuz.com" || host === "www.qobuz.com") {
    const [locale, rawKind, slug, id] = segments;
    if (!locale || !/^[a-z]{2}-[a-z]{2}$/i.test(locale)) return null;
    const kind = rawKind === "interpreter" ? "artist" : rawKind;
    if (kind && RESOURCE_KINDS.has(kind) && slug && id && /^[a-zA-Z0-9]+$/.test(id)) {
      return { kind: kind as QobuzResourceKind, id };
    }
    return null;
  }

  return null;
}

/**
 * Cover URLs ship sized (`_600.jpg` and friends); `_max.jpg` is the original
 * upload, available for both the legacy UPC-named covers and the newer opaque
 * ids.
 */
export function upgradeQobuzCoverUrl(url: string | undefined): string | undefined {
  return url?.replace(/_\d+\.jpg$/i, "_max.jpg");
}

const FULL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `release_date_original` is the release's own date, as `YYYY-MM-DD`. */
function releaseDateOf(data: Record<string, unknown>): string | undefined {
  const raw = getString(data.release_date_original);
  return raw && FULL_DATE.test(raw) ? raw : undefined;
}

/** The year from the full date, else from `released_at` (Unix seconds, pre-1970 included). */
function yearOf(
  data: Record<string, unknown>,
  releaseDate: string | undefined,
): number | undefined {
  if (releaseDate) return Number(releaseDate.slice(0, 4));
  const releasedAt = data.released_at;
  if (typeof releasedAt === "number" && Number.isFinite(releasedAt)) {
    return new Date(releasedAt * 1000).getUTCFullYear();
  }
  return undefined;
}

const ITEM_TYPES = new Set<string>(["album", "ep", "single", "track", "mix", "compilation"]);

/** Qobuz's `release_type` when it names a kind we model, else "album". */
function albumItemType(data: Record<string, unknown>): ItemType {
  const raw = getString(data.release_type)?.toLowerCase();
  return raw && ITEM_TYPES.has(raw) ? (raw as ItemType) : "album";
}

function coverOf(container: unknown): string | undefined {
  if (!isRecord(container)) return undefined;
  return upgradeQobuzCoverUrl(firstDefined(getString(container.large), getString(container.small)));
}

async function scrapeAlbum(id: string, timeoutMs: number): Promise<ScrapedMetadata | null> {
  const data = await fetchQobuzApi("album/get", { album_id: id }, timeoutMs);
  if (!data) return null;

  const releaseDate = releaseDateOf(data);
  const url = getString(data.url);
  const metadata: ScrapedMetadata = {
    potentialArtist: isRecord(data.artist) ? getString(data.artist.name) : undefined,
    potentialTitle: getString(data.title),
    itemType: albumItemType(data),
    imageUrl: coverOf(data.image),
    label: isRecord(data.label) ? getString(data.label.name) : undefined,
    genre: isRecord(data.genre) ? getString(data.genre.name) : undefined,
    releaseDate,
    year: yearOf(data, releaseDate),
    canonicalUrl: url ? qobuzStorefrontUrl(url) : undefined,
  };

  return hasScrapedMetadata(metadata) ? metadata : null;
}

async function scrapeTrack(id: string, timeoutMs: number): Promise<ScrapedMetadata | null> {
  const data = await fetchQobuzApi("track/get", { track_id: id }, timeoutMs);
  if (!data) return null;

  const album = isRecord(data.album) ? data.album : null;
  const releaseDate = releaseDateOf(data) ?? (album ? releaseDateOf(album) : undefined);
  const metadata: ScrapedMetadata = {
    potentialArtist: isRecord(data.performer) ? getString(data.performer.name) : undefined,
    potentialTitle: getString(data.title),
    itemType: "track",
    imageUrl: album ? coverOf(album.image) : undefined,
    label: album && isRecord(album.label) ? getString(album.label.name) : undefined,
    releaseDate,
    year: yearOf(data, releaseDate),
    // A track page has no URL of its own in the API — the link stays as pasted.
  };

  return hasScrapedMetadata(metadata) ? metadata : null;
}

async function scrapeArtist(id: string, timeoutMs: number): Promise<ScrapedMetadata | null> {
  const data = await fetchQobuzApi("artist/get", { artist_id: id }, timeoutMs);
  if (!data) return null;

  const metadata: ScrapedMetadata = {
    potentialArtist: getString(data.name),
    // Artist portraits are unsized hashes — no `_max` variant to upgrade to.
    imageUrl: isRecord(data.image) ? getString(data.image.large) : undefined,
  };

  return hasScrapedMetadata(metadata) ? metadata : null;
}

async function scrapePlaylist(id: string, timeoutMs: number): Promise<ScrapedMetadata | null> {
  const data = await fetchQobuzApi("playlist/get", { playlist_id: id }, timeoutMs);
  if (!data) return null;

  const image = isRecord(data.image) ? data.image : null;
  const firstCover = image && Array.isArray(image.covers) ? getString(image.covers[0]) : undefined;
  const metadata: ScrapedMetadata = {
    potentialTitle: getString(data.name),
    itemType: "mix",
    imageUrl: image
      ? firstDefined(getString(image.rectangle), upgradeQobuzCoverUrl(firstCover))
      : undefined,
  };

  return hasScrapedMetadata(metadata) ? metadata : null;
}

/** Scrape a Qobuz album, track, artist or playlist URL into draft-item metadata. */
export async function scrapeQobuz(url: string, timeoutMs: number): Promise<ScrapedMetadata | null> {
  const resource = parseQobuzUrl(url);
  if (!resource) return null;

  switch (resource.kind) {
    case "album":
      return scrapeAlbum(resource.id, timeoutMs);
    case "track":
      return scrapeTrack(resource.id, timeoutMs);
    case "artist":
      return scrapeArtist(resource.id, timeoutMs);
    case "playlist":
      return scrapePlaylist(resource.id, timeoutMs);
  }
}

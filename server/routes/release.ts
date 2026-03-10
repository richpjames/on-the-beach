import { Hono } from "hono";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq, and } from "drizzle-orm";
import { extractReleaseInfo } from "../vision";
import { lookupRelease } from "../musicbrainz";
import { fetchAndSaveCoverArt } from "../cover-art-archive";
import { createScanEnricher } from "../scan-enricher";
import type { ScanResult } from "../../src/types";
import type { MusicBrainzFields } from "../musicbrainz";
import { getUploadsDir, toUploadsPublicPath } from "../uploads";
import { searchAppleMusic } from "../scraper";
import { db } from "../db/index";
import { musicItems, musicLinks, sources, artists } from "../db/schema";

const MAX_IMAGE_BASE64_LENGTH = 2_000_000;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

interface ScanRequestBody {
  imageBase64?: unknown;
}

function validateImageBase64(
  value: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string") {
    return { ok: false, error: "imageBase64 must be a string" };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "imageBase64 is required" };
  }

  if (trimmed.length > MAX_IMAGE_BASE64_LENGTH) {
    return { ok: false, error: "imageBase64 is too large" };
  }

  if (!BASE64_PATTERN.test(trimmed)) {
    return { ok: false, error: "imageBase64 must be valid base64" };
  }

  return { ok: true, value: trimmed };
}

export type ExtractReleaseInfoFn = (base64Image: string) => Promise<ScanResult | null>;
export type SaveReleaseImageFn = (base64Image: string) => Promise<string>;
export type LookupReleaseFn = (
  artist: string,
  title: string,
  year?: string,
) => Promise<MusicBrainzFields | null>;

export type FetchCoverArtFn = (
  releaseId: string,
  saveImage: SaveReleaseImageFn,
) => Promise<string | null>;

export type SearchAppleMusicFn = (title: string, artist: string | null) => Promise<string | null>;

export interface ItemInfoForLookup {
  title: string;
  artistName: string | null;
  primarySource: string | null;
}

export type FetchItemForLookupFn = (id: number) => Promise<ItemInfoForLookup | null>;

export type SaveAppleMusicLinkFn = (itemId: number, url: string) => Promise<void>;

export type GetExistingAppleMusicLinkFn = (itemId: number) => Promise<string | null>;

export const PLAYABLE_SOURCES = new Set([
  "bandcamp",
  "spotify",
  "soundcloud",
  "youtube",
  "apple_music",
  "tidal",
  "deezer",
  "mixcloud",
]);

async function defaultFetchItemForLookup(id: number): Promise<ItemInfoForLookup | null> {
  const rows = await db
    .select({
      title: musicItems.title,
      artistName: artists.name,
      primarySource: sources.name,
    })
    .from(musicItems)
    .leftJoin(artists, eq(musicItems.artistId, artists.id))
    .leftJoin(
      musicLinks,
      and(eq(musicLinks.musicItemId, musicItems.id), eq(musicLinks.isPrimary, true)),
    )
    .leftJoin(sources, eq(musicLinks.sourceId, sources.id))
    .where(eq(musicItems.id, id))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    title: row.title,
    artistName: row.artistName ?? null,
    primarySource: row.primarySource ?? null,
  };
}

async function defaultGetExistingAppleMusicLink(itemId: number): Promise<string | null> {
  const rows = await db
    .select({ url: musicLinks.url })
    .from(musicLinks)
    .innerJoin(sources, eq(musicLinks.sourceId, sources.id))
    .where(and(eq(musicLinks.musicItemId, itemId), eq(sources.name, "apple_music")))
    .limit(1);

  return rows[0]?.url ?? null;
}

async function defaultSaveAppleMusicLink(itemId: number, url: string): Promise<void> {
  const sourceRows = await db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.name, "apple_music"))
    .limit(1);

  const sourceId = sourceRows[0]?.id ?? null;

  try {
    await db.insert(musicLinks).values({
      musicItemId: itemId,
      sourceId,
      url,
      isPrimary: false,
      metadata: null,
    });
  } catch {
    // Likely a unique constraint violation — link already exists
  }
}

async function saveReleaseImage(base64Image: string): Promise<string> {
  const uploadsDir = getUploadsDir();
  await mkdir(uploadsDir, { recursive: true });

  const filename = `${crypto.randomUUID()}.jpg`;
  const filePath = path.join(uploadsDir, filename);
  const imageBytes = Buffer.from(base64Image, "base64");
  await writeFile(filePath, imageBytes);

  return toUploadsPublicPath(filename);
}

export function createReleaseRoutes(
  scanReleaseCover: ExtractReleaseInfoFn = createScanEnricher(extractReleaseInfo, lookupRelease),
  saveImage: SaveReleaseImageFn = saveReleaseImage,
  lookupReleaseFn: LookupReleaseFn = lookupRelease,
  fetchCoverArtFn: FetchCoverArtFn = fetchAndSaveCoverArt,
  searchAppleMusicFn: SearchAppleMusicFn = searchAppleMusic,
  fetchItemForLookupFn: FetchItemForLookupFn = defaultFetchItemForLookup,
  getExistingAppleMusicLinkFn: GetExistingAppleMusicLinkFn = defaultGetExistingAppleMusicLink,
  saveAppleMusicLinkFn: SaveAppleMusicLinkFn = defaultSaveAppleMusicLink,
): Hono {
  const routes = new Hono();

  routes.post("/image", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err) {
      console.error("[api] POST /api/release/image invalid JSON:", err);
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    const validation = validateImageBase64((body as ScanRequestBody).imageBase64);
    if (!validation.ok) {
      return c.json({ error: validation.error }, 400);
    }

    try {
      const artworkUrl = await saveImage(validation.value);
      return c.json({ artworkUrl }, 201);
    } catch (err) {
      console.error("[api] POST /api/release/image failed to save image:", err);
      return c.json({ error: "Failed to save image" }, 500);
    }
  });

  routes.post("/scan", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err) {
      console.error("[api] POST /api/release/scan invalid JSON:", err);
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    const validation = validateImageBase64((body as ScanRequestBody).imageBase64);
    if (!validation.ok) {
      return c.json({ error: validation.error }, 400);
    }

    const scanResult = await scanReleaseCover(validation.value);
    if (!scanResult) {
      return c.json({ error: "Scan unavailable" }, 503);
    }

    return c.json(scanResult, 200);
  });

  routes.post("/lookup", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    const { artist, title, year } = body as Record<string, unknown>;

    if (typeof artist !== "string" || !artist.trim()) {
      return c.json({ error: "artist is required" }, 400);
    }

    if (typeof title !== "string" || !title.trim()) {
      return c.json({ error: "title is required" }, 400);
    }

    const yearHint = typeof year === "string" && year.trim() ? year.trim() : undefined;

    try {
      const mbFields = await lookupReleaseFn(artist.trim(), title.trim(), yearHint);
      if (!mbFields) {
        return c.json({}, 200);
      }

      const result: Record<string, unknown> = { ...mbFields };

      if (mbFields.musicbrainzReleaseId) {
        const artworkUrl = await fetchCoverArtFn(mbFields.musicbrainzReleaseId, saveImage);
        if (artworkUrl) {
          result.artworkUrl = artworkUrl;
        }
      }

      return c.json(result, 200);
    } catch {
      return c.json({}, 200);
    }
  });

  routes.post("/apple-music-lookup/:id", async (c) => {
    const rawId = c.req.param("id");
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: "Invalid ID" }, 400);
    }

    const item = await fetchItemForLookupFn(id);
    if (!item) {
      return c.json({ error: "Not found" }, 404);
    }

    if (item.primarySource && PLAYABLE_SOURCES.has(item.primarySource)) {
      return c.json({ skipped: true }, 200);
    }

    const existing = await getExistingAppleMusicLinkFn(id);
    if (existing) {
      return c.json({ url: existing }, 200);
    }

    const appleMusicUrl = await searchAppleMusicFn(item.title, item.artistName);
    if (!appleMusicUrl) {
      return c.json({ url: null }, 200);
    }

    await saveAppleMusicLinkFn(id, appleMusicUrl);

    return c.json({ url: appleMusicUrl }, 200);
  });

  return routes;
}

export const releaseRoutes = createReleaseRoutes();

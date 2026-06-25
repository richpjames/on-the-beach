import { Hono } from "hono";
import { extractReleaseInfo, extractReleaseInfoFromWebContext } from "../vision";
import { getWebContext } from "../google-vision";
import { lookupRelease } from "../musicbrainz";
import { fetchAndSaveCoverArt } from "../cover-art-archive";
import { createScanEnricher } from "../scan-enricher";
import type { ScanResult } from "../../src/types";
import type { MusicBrainzFields } from "../musicbrainz";
import { saveImageFromBase64, validateImageBase64 } from "../uploads";
import { db } from "../db/index";
import { sources } from "../db/schema";
import { recognizeAudio, isAcrCloudConfigured } from "../acrcloud";
import {
  fetchItemForLookup,
  getExistingAppleMusicLink,
  saveAppleMusicLink,
  searchAppleMusic,
  stampAppleMusicLookup,
  lookupAppleMusicForItem,
} from "../apple-music-enrichment";
import type {
  FetchItemForLookupFn,
  GetExistingAppleMusicLinkFn,
  SaveAppleMusicLinkFn,
  SearchAppleMusicFn,
  StampAppleMusicLookupFn,
} from "../apple-music-enrichment";

// Re-exported for backwards compatibility; the canonical definitions now live
// in ../apple-music-enrichment so the eager and backfill paths share them.
export type {
  ItemInfoForLookup,
  FetchItemForLookupFn,
  GetExistingAppleMusicLinkFn,
  SaveAppleMusicLinkFn,
  SearchAppleMusicFn,
  StampAppleMusicLookupFn,
} from "../apple-music-enrichment";

interface ScanRequestBody {
  imageBase64?: unknown;
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

export function createReleaseRoutes(
  scanReleaseCover: ExtractReleaseInfoFn = createScanEnricher(
    extractReleaseInfo,
    lookupRelease,
    getWebContext,
    extractReleaseInfoFromWebContext,
  ),
  saveImage: SaveReleaseImageFn = saveImageFromBase64,
  lookupReleaseFn: LookupReleaseFn = lookupRelease,
  fetchCoverArtFn: FetchCoverArtFn = fetchAndSaveCoverArt,
  searchAppleMusicFn: SearchAppleMusicFn = searchAppleMusic,
  fetchItemForLookupFn: FetchItemForLookupFn = fetchItemForLookup,
  getExistingAppleMusicLinkFn: GetExistingAppleMusicLinkFn = getExistingAppleMusicLink,
  saveAppleMusicLinkFn: SaveAppleMusicLinkFn = saveAppleMusicLink,
  stampAppleMusicLookupFn: StampAppleMusicLookupFn = stampAppleMusicLookup,
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

    const outcome = await lookupAppleMusicForItem(id, {
      fetchItem: fetchItemForLookupFn,
      getExisting: getExistingAppleMusicLinkFn,
      search: searchAppleMusicFn,
      save: saveAppleMusicLinkFn,
      stamp: stampAppleMusicLookupFn,
    });

    switch (outcome.kind) {
      case "not_found":
        return c.json({ error: "Not found" }, 404);
      case "skipped":
        return c.json({ skipped: true }, 200);
      case "result":
        return c.json({ url: outcome.url }, 200);
    }
  });

  routes.post("/recognize", async (c) => {
    if (!isAcrCloudConfigured()) {
      return c.json({ error: "Music recognition is not configured" }, 503);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err) {
      console.error("[api] POST /api/release/recognize invalid JSON:", err);
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    const { audioBase64, mimeType } = body as Record<string, unknown>;

    if (typeof audioBase64 !== "string" || !audioBase64.trim()) {
      return c.json({ error: "audioBase64 is required" }, 400);
    }

    const resolvedMimeType = typeof mimeType === "string" ? mimeType : "audio/webm";

    try {
      const result = await recognizeAudio(audioBase64.trim(), resolvedMimeType);
      if (!result) {
        return c.json({ recognized: false }, 200);
      }
      return c.json({ recognized: true, ...result }, 200);
    } catch (err) {
      console.error("[api] POST /api/release/recognize failed:", err);
      return c.json({ error: "Recognition failed" }, 500);
    }
  });

  routes.get("/sources", async (c) => {
    const rows = await db
      .select({ id: sources.id, name: sources.name, displayName: sources.displayName })
      .from(sources)
      .orderBy(sources.displayName);
    return c.json(rows);
  });

  return routes;
}

export const releaseRoutes = createReleaseRoutes();

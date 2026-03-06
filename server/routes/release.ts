import { Hono } from "hono";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractReleaseInfo } from "../vision";
import { lookupRelease } from "../musicbrainz";
import { fetchAndSaveCoverArt } from "../cover-art-archive";
import { createScanEnricher } from "../scan-enricher";
import type { ScanResult } from "../../src/types";
import type { MusicBrainzFields } from "../musicbrainz";
import { getUploadsDir, toUploadsPublicPath } from "../uploads";

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

  return routes;
}

export const releaseRoutes = createReleaseRoutes();

import { Hono } from "hono";
import { extractMusicUrls } from "../email-parser";
import { createMusicItemDirect, createMusicItemsFromUrl } from "../music-item-creator";
import { isValidUrl } from "../utils";
import { saveImageFromBase64, validateImageBase64 } from "../uploads";
import { createScanEnricher } from "../scan-enricher";
import { extractReleaseInfo, extractReleaseInfoFromWebContext } from "../vision";
import { getWebContext } from "../google-vision";
import { lookupRelease } from "../musicbrainz";
import type { ScanResult } from "../../src/types";

interface EmailEnvelope {
  from: string;
  to: string;
  subject: string;
  html?: string;
  text?: string;
}

type ProviderAdapter = (body: Record<string, unknown>) => EmailEnvelope;

const providers: Record<string, ProviderAdapter> = {
  generic: (body) => body as unknown as EmailEnvelope,
  sendgrid: (body) => ({
    from: String(body.from ?? ""),
    to: String(body.to ?? ""),
    subject: String(body.subject ?? ""),
    html: body.html ? String(body.html) : undefined,
    text: body.text ? String(body.text) : undefined,
  }),
};

export type ScanPhotoFn = (base64Image: string) => Promise<ScanResult | null>;
export type SavePhotoFn = (base64Image: string) => Promise<string>;

export interface IngestRoutesDeps {
  scanPhoto?: ScanPhotoFn;
  savePhoto?: SavePhotoFn;
}

export function createIngestRoutes(deps: IngestRoutesDeps = {}): Hono {
  const scanPhoto =
    deps.scanPhoto ??
    createScanEnricher(
      extractReleaseInfo,
      lookupRelease,
      getWebContext,
      extractReleaseInfoFromWebContext,
    );
  const savePhoto = deps.savePhoto ?? saveImageFromBase64;

  const routes = new Hono();

  routes.post("/email", async (c) => {
    const apiKey = process.env.INGEST_API_KEY;
    if (!apiKey) {
      return c.json({ error: "Ingest not configured" }, 503);
    }

    if (process.env.INGEST_ENABLED === "false") {
      return c.json({ error: "Ingest disabled" }, 503);
    }

    const auth = c.req.header("Authorization");
    if (auth !== `Bearer ${apiKey}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const provider = c.req.query("provider") || "generic";
    const adapter = providers[provider];
    if (!adapter) {
      return c.json({ error: `Unknown provider: ${provider}` }, 400);
    }

    const body = await c.req.json();
    const envelope = adapter(body);

    const urls = extractMusicUrls(
      { html: envelope.html, text: envelope.text },
      { includeUnknown: true },
    );

    const items: Array<{ id: number; title: string; url: string }> = [];
    const skipped: Array<{ url: string; reason: string }> = [];

    for (const url of urls) {
      try {
        const results = await createMusicItemsFromUrl(url, {
          notes: `Via email from ${envelope.from}`,
        });

        for (const result of results) {
          if (result.created) {
            items.push({
              id: result.item.id,
              title: result.item.title,
              url: result.item.primary_url || url,
            });
          } else {
            skipped.push({ url, reason: "duplicate" });
          }
        }
      } catch (err) {
        console.error(`[api] POST /api/ingest/email failed to create item for ${url}:`, err);
        skipped.push({ url, reason: "creation_failed" });
      }
    }

    return c.json({
      received: true,
      items_created: items.length,
      items_skipped: skipped.length,
      items,
      skipped,
    });
  });

  routes.post("/link", async (c) => {
    const apiKey = process.env.INGEST_API_KEY;
    if (!apiKey) {
      return c.json({ error: "Ingest not configured" }, 503);
    }

    if (process.env.INGEST_ENABLED === "false") {
      return c.json({ error: "Ingest disabled" }, 503);
    }

    const auth = c.req.header("Authorization");
    if (auth !== `Bearer ${apiKey}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const body = await c.req.json();
    const url = typeof body?.url === "string" ? body.url.trim() : "";

    if (!url || !isValidUrl(url)) {
      return c.json({ error: "Missing or invalid url" }, 400);
    }

    try {
      const results = await createMusicItemsFromUrl(url);

      const items: Array<{ id: number; title: string; url: string }> = [];
      const skipped: Array<{ url: string; reason: string }> = [];

      for (const result of results) {
        if (result.created) {
          items.push({
            id: result.item.id,
            title: result.item.title,
            url: result.item.primary_url || url,
          });
        } else {
          skipped.push({ url, reason: "duplicate" });
        }
      }

      return c.json({
        received: true,
        items_created: items.length,
        items_skipped: skipped.length,
        items,
        skipped,
      });
    } catch (err) {
      console.error(`[api] POST /api/ingest/link failed for ${url}:`, err);
      return c.json({ error: "Failed to create item" }, 422);
    }
  });

  routes.post("/photo", async (c) => {
    const apiKey = process.env.INGEST_API_KEY;
    if (!apiKey) {
      return c.json({ error: "Ingest not configured" }, 503);
    }

    if (process.env.INGEST_ENABLED === "false") {
      return c.json({ error: "Ingest disabled" }, 503);
    }

    const auth = c.req.header("Authorization");
    if (auth !== `Bearer ${apiKey}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err) {
      console.error("[api] POST /api/ingest/photo invalid JSON:", err);
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    const { imageBase64, notes, from } = body as Record<string, unknown>;
    const validation = validateImageBase64(imageBase64);
    if (!validation.ok) {
      return c.json({ error: validation.error }, 400);
    }

    let artworkUrl: string;
    try {
      artworkUrl = await savePhoto(validation.value);
    } catch (err) {
      console.error("[api] POST /api/ingest/photo failed to save image:", err);
      return c.json({ error: "Failed to save image" }, 500);
    }

    let scan: ScanResult | null = null;
    try {
      scan = await scanPhoto(validation.value);
    } catch (err) {
      console.error("[api] POST /api/ingest/photo scan failed:", err);
    }

    const noteParts: string[] = [];
    if (typeof notes === "string" && notes.trim()) noteParts.push(notes.trim());
    if (typeof from === "string" && from.trim()) noteParts.push(`Via photo from ${from.trim()}`);

    try {
      const result = await createMusicItemDirect({
        title: scan?.title ?? undefined,
        artistName: scan?.artist ?? undefined,
        artworkUrl,
        year: scan?.year ?? undefined,
        label: scan?.label ?? undefined,
        country: scan?.country ?? undefined,
        catalogueNumber: scan?.catalogueNumber ?? undefined,
        musicbrainzReleaseId: scan?.musicbrainzReleaseId ?? undefined,
        musicbrainzArtistId: scan?.musicbrainzArtistId ?? undefined,
        notes: noteParts.length ? noteParts.join(" — ") : undefined,
      });

      return c.json({
        received: true,
        items_created: 1,
        items_skipped: 0,
        items: [
          {
            id: result.item.id,
            title: result.item.title,
            artworkUrl,
          },
        ],
        scan: scan
          ? {
              artist: scan.artist,
              title: scan.title,
              artistConfidence: scan.artistConfidence,
              titleConfidence: scan.titleConfidence,
            }
          : null,
      });
    } catch (err) {
      console.error("[api] POST /api/ingest/photo failed to create item:", err);
      return c.json({ error: "Failed to create item", artworkUrl }, 422);
    }
  });

  return routes;
}

export const ingestRoutes = createIngestRoutes();

import { Hono } from "hono";
import { asc, eq } from "drizzle-orm";
import { extractMusicUrls } from "../email-parser";
import { createMusicItemDirect, createMusicItemsFromUrl } from "../music-item-creator";
import { scheduleAppleMusicBackfill } from "../apple-music-backfill";
import { isValidUrl } from "../utils";
import { saveImageFromBase64, validateImageBase64 } from "../uploads";
import { createScanEnricher } from "../scan-enricher";
import { extractReleaseInfo, extractReleaseInfoFromWebContext } from "../vision";
import { getWebContext } from "../google-vision";
import { lookupRelease } from "../musicbrainz";
import { db } from "../db";
import { stacks, musicItemStacks } from "../db/schema";
import type { CreateMusicItemInput, ScanResult } from "../../src/types";

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

/** A list (stack) as the share-sheet picker needs it: just id + name. */
export interface IngestStack {
  id: number;
  name: string;
}

export type ListStacksFn = () => Promise<IngestStack[]>;
export type ResolveOrCreateStackFn = (name: string) => Promise<IngestStack>;
export type AttachItemToStackFn = (itemId: number, stackId: number) => Promise<void>;

export interface IngestRoutesDeps {
  scanPhoto?: ScanPhotoFn;
  savePhoto?: SavePhotoFn;
  listStacks?: ListStacksFn;
  resolveOrCreateStack?: ResolveOrCreateStackFn;
  attachItemToStack?: AttachItemToStackFn;
}

/** Every list, id + name, alphabetised — the payload the extension's picker shows. */
async function defaultListStacks(): Promise<IngestStack[]> {
  return db.select({ id: stacks.id, name: stacks.name }).from(stacks).orderBy(asc(stacks.name));
}

/**
 * Find a list by name or create it. Stack names are UNIQUE, so this collapses
 * the picker's "pick existing" and "create new" cases into one call. The
 * onConflictDoNothing + re-select guards against a race where a concurrent
 * request inserts the same name between our lookup and insert.
 */
async function defaultResolveOrCreateStack(name: string): Promise<IngestStack> {
  const trimmed = name.trim();

  const existing = await db
    .select({ id: stacks.id, name: stacks.name })
    .from(stacks)
    .where(eq(stacks.name, trimmed))
    .get();
  if (existing) return existing;

  const inserted = await db
    .insert(stacks)
    .values({ name: trimmed })
    .onConflictDoNothing()
    .returning({ id: stacks.id, name: stacks.name });
  if (inserted[0]) return inserted[0];

  // Lost the race — the row now exists, so read it back.
  const row = await db
    .select({ id: stacks.id, name: stacks.name })
    .from(stacks)
    .where(eq(stacks.name, trimmed))
    .get();
  if (!row) throw new Error(`Failed to resolve list "${trimmed}"`);
  return row;
}

async function defaultAttachItemToStack(itemId: number, stackId: number): Promise<void> {
  await db.insert(musicItemStacks).values({ musicItemId: itemId, stackId }).onConflictDoNothing();
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
  const listStacks = deps.listStacks ?? defaultListStacks;
  const resolveOrCreateStack = deps.resolveOrCreateStack ?? defaultResolveOrCreateStack;
  const attachItemToStack = deps.attachItemToStack ?? defaultAttachItemToStack;

  const routes = new Hono();

  // GET /stacks — lists for the share-sheet picker. Bearer-authed with the
  // ingest key because the extension can't use the session-authed /api/stacks.
  routes.get("/stacks", async (c) => {
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

    return c.json({ stacks: await listStacks() });
  });

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
            scheduleAppleMusicBackfill(result.item.id);
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

    const notes = typeof body?.notes === "string" ? body.notes.trim() : "";
    const listName = typeof body?.listName === "string" ? body.listName.trim() : "";

    // Notes are only meaningful for a freshly-created item; createMusicItemsFromUrl
    // returns a duplicate's existing item unchanged, so passing them there can never
    // clobber an existing note.
    const overrides: Partial<CreateMusicItemInput> = {};
    if (notes) overrides.notes = notes;

    try {
      const results = Object.keys(overrides).length
        ? await createMusicItemsFromUrl(url, overrides)
        : await createMusicItemsFromUrl(url);

      // Resolve the list once (creating it if new), then file every returned item
      // into it — including duplicates, so re-sharing to organise works.
      const list = listName ? await resolveOrCreateStack(listName) : null;

      const items: Array<{ id: number; title: string; url: string }> = [];
      const skipped: Array<{ url: string; reason: string }> = [];

      for (const result of results) {
        if (list) {
          await attachItemToStack(result.item.id, list.id);
        }
        if (result.created) {
          scheduleAppleMusicBackfill(result.item.id);
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
        list,
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

    let imageBase64: unknown;
    let notes: unknown;
    let from: unknown;

    const contentType = c.req.header("Content-Type") ?? "";

    if (contentType.includes("multipart/form-data")) {
      // iPhone Shortcuts and other clients send the photo as a file field.
      let form: Record<string, string | File>;
      try {
        form = (await c.req.parseBody()) as Record<string, string | File>;
      } catch (err) {
        console.error("[api] POST /api/ingest/photo invalid form data:", err);
        return c.json({ error: "Invalid form data" }, 400);
      }

      const file = form.photo ?? form.image ?? form.file;
      if (!(file instanceof File)) {
        return c.json({ error: "photo file is required" }, 400);
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      imageBase64 = buffer.toString("base64");
      notes = form.notes;
      from = form.from;
    } else {
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

      ({ imageBase64, notes, from } = body as Record<string, unknown>);
    }

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

      scheduleAppleMusicBackfill(result.item.id);

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

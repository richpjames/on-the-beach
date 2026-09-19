import { Hono } from "hono";
import { asc, count, eq } from "drizzle-orm";
import { extractMusicUrls } from "../../app/email-parser";
import {
  AmbiguousLinkSelectionError,
  createMusicItemDirect,
  createMusicItemsFromUrl,
  remindAtForScrapedRelease,
} from "../../app/music-item-creator";
import { scheduleAppleMusicBackfill } from "../../app/apple-music-backfill";
import { scrapeUrl } from "../../app/scrape";
import { sourceNamesReleaseDate } from "../../adapters/registry";
import { isValidUrl } from "../../domain/text";
import { parseUrl } from "../../adapters/registry";
import { saveImageFromBase64, validateImageBase64 } from "../uploads";
import { createScanEnricher } from "../../app/scan-enricher";
import { extractReleaseInfo, extractReleaseInfoFromWebContext } from "../../adapters/mistral/index";
import { getWebContext } from "../../adapters/google-vision/index";
import { lookupRelease } from "../../adapters/musicbrainz/index";
import { db } from "../../adapters/db/index";
import { stacks, musicItemStacks, musicItems } from "../../adapters/db/schema";
import type { CreateMusicItemInput, ScanResult, SourceName } from "../../domain/types";

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

/**
 * What a link says about itself before anything is added — today just the
 * release date, which is what the share sheet's "Release date" control wants
 * filled in for it.
 *
 * `remindAt` is the date the sheet should pre-arm: the release date when the
 * record isn't out yet, null when it is (or when scheduling is switched off).
 * Deciding that here rather than in the client keeps a shared pre-order and an
 * ingested one landing on exactly the same day.
 */
export interface LinkPreview {
  url: string;
  source: SourceName;
  releaseDate: string | null;
  remindAt: string | null;
}

export type PreviewLinkFn = (url: string) => Promise<LinkPreview>;
export type ListStacksFn = () => Promise<IngestStack[]>;
export type ResolveOrCreateStackFn = (name: string) => Promise<IngestStack>;
export type AttachItemToStackFn = (itemId: number, stackId: number) => Promise<void>;
export type SetItemReminderFn = (itemId: number, remindAt: Date) => Promise<void>;
export type CountToListenFn = () => Promise<number>;

export interface IngestRoutesDeps {
  scanPhoto?: ScanPhotoFn;
  savePhoto?: SavePhotoFn;
  previewLink?: PreviewLinkFn;
  listStacks?: ListStacksFn;
  resolveOrCreateStack?: ResolveOrCreateStackFn;
  attachItemToStack?: AttachItemToStackFn;
  setItemReminder?: SetItemReminderFn;
  countToListen?: CountToListenFn;
}

/**
 * Read a link's release date without adding anything.
 *
 * Only sources that print one are fetched — everything else answers from the
 * URL alone, so previewing a Spotify share costs no request. A scrape that
 * fails is reported as "no date": the preview is a convenience, and a share
 * must never be held up by it.
 */
async function defaultPreviewLink(url: string): Promise<LinkPreview> {
  const parsed = parseUrl(url);
  const empty: LinkPreview = {
    url: parsed.normalizedUrl,
    source: parsed.source,
    releaseDate: null,
    remindAt: null,
  };

  if (!sourceNamesReleaseDate(parsed.source)) return empty;

  try {
    const scraped = await scrapeUrl(parsed.normalizedUrl, parsed.source);
    const releaseDate = scraped?.releaseDate ?? null;
    const remindAt = await remindAtForScrapedRelease(releaseDate ?? undefined);

    return {
      ...empty,
      releaseDate,
      remindAt: remindAt ? remindAt.toISOString().slice(0, 10) : null,
    };
  } catch (err) {
    console.error(`[api] GET /api/ingest/link-preview failed to read ${url}:`, err);
    return empty;
  }
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

/**
 * Count the items still queued to listen to — the number the iOS home-screen
 * widget shows. Just `listen_status = 'to-listen'` (the only non-listened
 * state); the `idx_music_items_listen_status` index keeps it cheap.
 */
async function defaultCountToListen(): Promise<number> {
  const row = await db
    .select({ value: count() })
    .from(musicItems)
    .where(eq(musicItems.listenStatus, "to-listen"))
    .get();
  return row?.value ?? 0;
}

/** Set an item's scheduled reminder date — the share sheet's "Remind me". */
async function defaultSetItemReminder(itemId: number, remindAt: Date): Promise<void> {
  await db
    .update(musicItems)
    .set({ remindAt, updatedAt: new Date() })
    .where(eq(musicItems.id, itemId));
}

/**
 * Parse an optional `remindAt` scheduled date from a /link request body. Returns
 * the parsed Date, `null` when absent/blank, or an `error` when present but not a
 * valid date string — mirroring the strictness of the /:id/reminder endpoint so a
 * mis-formatted client is surfaced rather than silently dropping the schedule.
 */
function parseRemindAt(body: unknown): { date: Date | null } | { error: string } {
  if (!body || typeof body !== "object") return { date: null };
  const { remindAt } = body as Record<string, unknown>;
  if (remindAt === undefined || remindAt === null || remindAt === "") return { date: null };
  if (typeof remindAt !== "string") return { error: "remindAt must be a date string" };
  const date = new Date(remindAt);
  if (isNaN(date.getTime())) return { error: "remindAt must be a valid date" };
  return { date };
}

/**
 * Gather the release candidate ids a /link request selected — the share
 * sheet's second POST after a multi-release page came back as 409
 * `ambiguous_link`. Trims each, drops blanks/non-strings, and de-dupes.
 */
function collectSelectedCandidateIds(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const { selectedCandidateIds } = body as Record<string, unknown>;
  if (!Array.isArray(selectedCandidateIds)) return [];

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of selectedCandidateIds) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    ids.push(trimmed);
  }
  return ids;
}

/**
 * Gather the list names a /link request wants the item filed into, from either
 * `listNames` (multi-select share sheet) or the legacy single `listName`.
 * Trims each, drops blanks, and de-dupes case-sensitively by name.
 */
function collectListNames(body: unknown): string[] {
  const raw: unknown[] = [];
  if (body && typeof body === "object") {
    const { listName, listNames } = body as Record<string, unknown>;
    if (Array.isArray(listNames)) raw.push(...listNames);
    if (listName !== undefined) raw.push(listName);
  }

  const seen = new Set<string>();
  const names: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    names.push(trimmed);
  }
  return names;
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
  const previewLink = deps.previewLink ?? defaultPreviewLink;
  const listStacks = deps.listStacks ?? defaultListStacks;
  const resolveOrCreateStack = deps.resolveOrCreateStack ?? defaultResolveOrCreateStack;
  const attachItemToStack = deps.attachItemToStack ?? defaultAttachItemToStack;
  const setItemReminder = deps.setItemReminder ?? defaultSetItemReminder;
  const countToListen = deps.countToListen ?? defaultCountToListen;

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

  // GET /stats — the to-listen count for clients that can't use the
  // session-authed app API, so it's Bearer-authed with the ingest key (same as
  // /stacks). Originally fed the iOS home-screen widget, which now just shows the
  // logo; kept as a tiny, generally useful counter.
  routes.get("/stats", async (c) => {
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

    return c.json({ to_listen: await countToListen() });
  });

  // GET /link-preview?url=… — what the share sheet can fill in before the user
  // taps Add. Bearer-authed with the ingest key like /stacks and /stats, since
  // the extension has no session either.
  routes.get("/link-preview", async (c) => {
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

    const url = (c.req.query("url") ?? "").trim();
    if (!url || !isValidUrl(url)) {
      return c.json({ error: "Missing or invalid url" }, 400);
    }

    return c.json(await previewLink(url));
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

    // Accept both the single `listName` (older extension builds) and `listNames`
    // (multi-select share sheet). Trim, drop blanks, and de-dupe by name so the
    // same list picked twice only files the item once.
    const listNames = collectListNames(body);

    // Optional scheduled date ("Remind me" in the share sheet). Absent/blank
    // leaves the item unscheduled; a present-but-invalid value is a client bug.
    const remindAtResult = parseRemindAt(body);
    if ("error" in remindAtResult) {
      return c.json({ error: remindAtResult.error }, 400);
    }
    const remindAt = remindAtResult.date;

    // Notes are only meaningful for a freshly-created item; createMusicItemsFromUrl
    // returns a duplicate's existing item unchanged, so passing them there can never
    // clobber an existing note.
    const overrides: Partial<CreateMusicItemInput> = {};
    if (notes) overrides.notes = notes;

    // The share sheet's answer to an earlier `ambiguous_link` response: which
    // of the page's releases to add. One item is created per selected id.
    const selectedCandidateIds = collectSelectedCandidateIds(body);
    if (selectedCandidateIds.length) overrides.selectedCandidateIds = selectedCandidateIds;

    try {
      const results = Object.keys(overrides).length
        ? await createMusicItemsFromUrl(url, overrides)
        : await createMusicItemsFromUrl(url);

      // Resolve each list once (creating any that are new), then file every
      // returned item into all of them — including duplicates, so re-sharing to
      // organise works.
      const lists = await Promise.all(listNames.map((name) => resolveOrCreateStack(name)));

      const items: Array<{ id: number; title: string; url: string }> = [];
      const skipped: Array<{ url: string; reason: string }> = [];

      for (const result of results) {
        for (const list of lists) {
          await attachItemToStack(result.item.id, list.id);
        }
        // Apply the schedule to every returned item — including duplicates, so
        // re-sharing an already-saved item to set (or update) its date works,
        // just like re-sharing to file it into a list does.
        if (remindAt) {
          await setItemReminder(result.item.id, remindAt);
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
        lists,
      });
    } catch (err) {
      if (err instanceof AmbiguousLinkSelectionError) {
        // The page names several releases and none stood out as primary. Hand
        // the candidates back (same 409 shape as POST /api/music-items) so the
        // share sheet can show its release picker and re-post a selection.
        return c.json(err.payload, 409);
      }

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
    // Lists and an optional reminder date the item should be filed with — the
    // share sheet sends these for a photo just as it does for a link, so a
    // shared image lands in the same lists (and gets the same "Remind me" date)
    // as a shared URL would.
    let listNames: string[] = [];
    let remindAtRaw: unknown;

    const contentType = c.req.header("Content-Type") ?? "";

    if (contentType.includes("multipart/form-data")) {
      // iPhone Shortcuts and other clients send the photo as a file field.
      // `all: true` collects repeated fields (e.g. several `listNames`) into an
      // array while leaving single-valued fields untouched.
      let form: Record<string, string | File | (string | File)[]>;
      try {
        form = await c.req.parseBody({ all: true });
      } catch (err) {
        console.error("[api] POST /api/ingest/photo invalid form data:", err);
        return c.json({ error: "Invalid form data" }, 400);
      }

      const fileField = form.photo ?? form.image ?? form.file;
      const file = Array.isArray(fileField) ? fileField[0] : fileField;
      if (!(file instanceof File)) {
        return c.json({ error: "photo file is required" }, 400);
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      imageBase64 = buffer.toString("base64");
      notes = Array.isArray(form.notes) ? form.notes[0] : form.notes;
      from = Array.isArray(form.from) ? form.from[0] : form.from;
      listNames = collectListNames({
        listName: Array.isArray(form.listName) ? form.listName[0] : form.listName,
        listNames: Array.isArray(form.listNames)
          ? form.listNames
          : form.listNames !== undefined
            ? [form.listNames]
            : [],
      });
      remindAtRaw = Array.isArray(form.remindAt) ? form.remindAt[0] : form.remindAt;
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

      const record = body as Record<string, unknown>;
      ({ imageBase64, notes, from } = record);
      listNames = collectListNames(record);
      remindAtRaw = record.remindAt;
    }

    const validation = validateImageBase64(imageBase64);
    if (!validation.ok) {
      return c.json({ error: validation.error }, 400);
    }

    // Validate the reminder before saving anything, so a mis-formatted date
    // fails cleanly instead of leaving an orphaned upload behind.
    const remindAtResult = parseRemindAt({ remindAt: remindAtRaw });
    if ("error" in remindAtResult) {
      return c.json({ error: remindAtResult.error }, 400);
    }
    const remindAt = remindAtResult.date;

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

      // File the new item into every chosen list (creating any that are new),
      // then apply the reminder — mirroring the /link path so the share sheet's
      // list and "Remind me" controls behave the same for a photo.
      const lists = await Promise.all(listNames.map((name) => resolveOrCreateStack(name)));
      for (const list of lists) {
        await attachItemToStack(result.item.id, list.id);
      }
      if (remindAt) {
        await setItemReminder(result.item.id, remindAt);
      }

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
        lists,
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

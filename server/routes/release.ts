import { Hono } from "hono";
import { extractReleaseInfo, extractReleaseInfoFromWebContext } from "../../adapters/mistral/index";
import { getWebContext } from "../../adapters/google-vision/index";
import { fetchAndSaveCoverArt } from "../../adapters/musicbrainz/cover-art-archive";
import { createScanEnricher } from "../../app/scan-enricher";
import {
  resolveRelease,
  type ReleaseQuery,
  type ResolutionOutcome,
} from "../../app/release-resolver";
import type { ScanResult } from "../../domain/types";
import { saveImageFromBase64, validateImageBase64 } from "../uploads";
import { db } from "../../adapters/db/index";
import { sources } from "../../adapters/db/schema";
import { recognizeAudio, isAcrCloudConfigured } from "../../adapters/acrcloud/index";
import {
  lookupSecondaryLinkForItem,
  type SecondaryLookupOutcome,
} from "../../app/secondary-link-enrichment";
import { lookupNotesForItem, type NotesEnrichmentOutcome } from "../../app/notes-enrichment";
import { lookupResolutionForItem, type ResolutionLookupOutcome } from "../../app/resolution-lookup";

export type LookupSecondaryLinkFn = (itemId: number) => Promise<SecondaryLookupOutcome>;
export type LookupNotesFn = (itemId: number) => Promise<NotesEnrichmentOutcome>;
export type LookupResolutionFn = (itemId: number) => Promise<ResolutionLookupOutcome>;

interface ScanRequestBody {
  imageBase64?: unknown;
}

export type ExtractReleaseInfoFn = (base64Image: string) => Promise<ScanResult | null>;
export type SaveReleaseImageFn = (base64Image: string) => Promise<string>;
export type ResolveReleaseFn = (query: ReleaseQuery) => Promise<ResolutionOutcome>;

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
  "qobuz",
  "mixcloud",
]);

export function createReleaseRoutes(
  scanReleaseCover: ExtractReleaseInfoFn = createScanEnricher(
    extractReleaseInfo,
    resolveRelease,
    getWebContext,
    extractReleaseInfoFromWebContext,
  ),
  saveImage: SaveReleaseImageFn = saveImageFromBase64,
  resolveReleaseFn: ResolveReleaseFn = resolveRelease,
  fetchCoverArtFn: FetchCoverArtFn = fetchAndSaveCoverArt,
  lookupSecondaryLinkFn: LookupSecondaryLinkFn = lookupSecondaryLinkForItem,
  lookupResolutionFn: LookupResolutionFn = lookupResolutionForItem,
  lookupNotesFn: LookupNotesFn = lookupNotesForItem,
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

    // Enrichment is best-effort, so under OTB_DISABLE_EXTERNAL_LOOKUPS (tests)
    // answer "nothing found" rather than reaching the providers or Cover Art Archive.
    if (process.env.OTB_DISABLE_EXTERNAL_LOOKUPS) {
      return c.json({}, 200);
    }

    try {
      const parsedYear = yearHint && /^\d{4}$/.test(yearHint) ? Number(yearHint) : undefined;
      const outcome = await resolveReleaseFn({
        artist: artist.trim(),
        title: title.trim(),
        year: parsedYear,
      });
      if (!outcome.ids) {
        // Absent (nothing verified anywhere) and failed (request did not
        // complete) both degrade to "nothing found" — same contract the
        // add form has always had.
        return c.json({}, 200);
      }

      const ids = outcome.ids;
      const result: Record<string, unknown> = {
        year: ids.year,
        label: ids.label,
        country: ids.country,
        catalogueNumber: ids.catalogueNumber,
        musicbrainzReleaseId: ids.musicbrainzReleaseId,
        musicbrainzReleaseGroupId: ids.musicbrainzReleaseGroupId,
        musicbrainzArtistId: ids.musicbrainzArtistId,
        discogsReleaseId: ids.discogsReleaseId,
        discogsMasterId: ids.discogsMasterId,
        resolutionConfidence: ids.confidence,
        resolutionStatus: outcome.status,
      };

      if (ids.musicbrainzReleaseId) {
        const artworkUrl = await fetchCoverArtFn(ids.musicbrainzReleaseId, saveImage);
        if (artworkUrl) {
          result.artworkUrl = artworkUrl;
        }
      }

      return c.json(result, 200);
    } catch {
      return c.json({}, 200);
    }
  });

  routes.post("/secondary-link-lookup/:id", async (c) => {
    const rawId = c.req.param("id");
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: "Invalid ID" }, 400);
    }

    const outcome = await lookupSecondaryLinkFn(id);

    switch (outcome.kind) {
      case "not_found":
        return c.json({ error: "Not found" }, 404);
      case "skipped":
        return c.json({ skipped: true }, 200);
      case "result":
        return c.json(
          {
            url: outcome.url,
            service: outcome.service,
            serviceDisplayName: outcome.serviceDisplayName,
          },
          200,
        );
    }
  });

  // The on-view catalogue lookup: opening a release asks the resolver what
  // the record is when nothing has asked before (or the last attempt failed).
  // The page fires it without blocking the render; the verdict is stamped on
  // the row and answered back for the provenance line. All skip rules live in
  // the lookup itself — `absent` is terminal, ids from any path keep their
  // provenance — so a re-open never re-asks a settled question.
  routes.post("/resolution-lookup/:id", async (c) => {
    const rawId = c.req.param("id");
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: "Invalid ID" }, 400);
    }

    const outcome = await lookupResolutionFn(id);

    switch (outcome.kind) {
      case "not_found":
        return c.json({ error: "Not found" }, 404);
      case "skipped":
        return c.json({ skipped: true }, 200);
      case "result":
        return c.json(
          {
            resolutionStatus: outcome.status,
            musicbrainzReleaseId: outcome.ids?.musicbrainzReleaseId ?? null,
            musicbrainzReleaseGroupId: outcome.ids?.musicbrainzReleaseGroupId ?? null,
            musicbrainzArtistId: outcome.ids?.musicbrainzArtistId ?? null,
            discogsReleaseId: outcome.ids?.discogsReleaseId ?? null,
            discogsMasterId: outcome.ids?.discogsMasterId ?? null,
          },
          200,
        );
    }
  });

  // The on-view notes lookup: opening a release whose notes are empty (or
  // less than a sentence) fetches the first paragraph of its best-ranked
  // MusicBrainz external link. The page fires it without blocking the render;
  // all skip rules live in the lookup itself, so a re-open never re-fetches a
  // settled item.
  routes.post("/notes-lookup/:id", async (c) => {
    const rawId = c.req.param("id");
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: "Invalid ID" }, 400);
    }

    const outcome = await lookupNotesFn(id);

    switch (outcome.kind) {
      case "not_found":
        return c.json({ error: "Not found" }, 404);
      case "skipped":
        return c.json({ skipped: true }, 200);
      case "result":
        return c.json({ notes: outcome.notes, source: outcome.source }, 200);
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

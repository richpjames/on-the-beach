import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../adapters/db/index";
import { musicItems } from "../../adapters/db/schema";
import { createMusicItemDirect } from "../../app/music-item-store";
import type { CreateMusicItemInput } from "../../domain/types";

// The on-view lookup's contract: opening an unresolved release resolves and
// stamps it; absent is terminal, failed stays retryable after a cooldown,
// concurrent opens share one ask, and rows with ids from another path are
// left alone. The resolver itself is mocked — its quality is the eval's
// business, not this trigger's.

// Imported before mock.module so the real resolver can be handed back when
// this file is done — bun's mock.module() persists process-wide and mutates
// the imported namespace in place (see resolution-backfill.test.ts), so the
// real function has to be held by value.
import * as realResolver from "../../app/release-resolver";

const realResolveRelease = realResolver.resolveRelease;
const resolveRelease = mock((_query: unknown) => Promise.resolve({ status: "absent", ids: null }));

mock.module("../../app/release-resolver", () => ({
  ...realResolver,
  resolveRelease: (query: unknown) => resolveRelease(query),
}));

const { lookupResolutionForItem, FAILED_RETRY_COOLDOWN_MS } =
  await import("../../app/resolution-lookup");

// Rows this file creates, taken back out of the shared database afterwards —
// an eligible row left behind would be swept up by a neighbouring file's
// backfill run.
const created: number[] = [];

beforeEach(() => {
  // The lookup no-ops with external lookups switched off; neighbouring files
  // leave the flag set, so clear it around every test in both directions.
  delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
});

afterEach(async () => {
  resolveRelease.mockClear();
  delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
  for (const id of created) {
    await db.delete(musicItems).where(eq(musicItems.id, id));
  }
  created.length = 0;
});

afterAll(() => {
  mock.module("../../app/release-resolver", () => ({
    ...realResolver,
    resolveRelease: realResolveRelease,
  }));
});

/** Create a row with the background enrichment hooks switched off. */
async function createRow(overrides: Partial<CreateMusicItemInput> = {}) {
  process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";
  try {
    const { item } = await createMusicItemDirect(overrides, { skipLinkEnrichment: true });
    created.push(item.id);
    return item;
  } finally {
    delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
  }
}

function matchedIds(overrides: Record<string, unknown> = {}) {
  return {
    musicbrainzReleaseId: "mb-1",
    musicbrainzReleaseGroupId: "rg-1",
    musicbrainzArtistId: "mba-1",
    discogsReleaseId: 4419535,
    discogsMasterId: 706722,
    year: 1978,
    label: "Bronze",
    country: "GB",
    catalogueNumber: "BRON 511",
    confidence: 0.95,
    ...overrides,
  };
}

describe("lookupResolutionForItem", () => {
  test("resolves an un-resolved row and stamps the verdict", async () => {
    const item = await createRow({ artistName: "Orquesta El Macabeo", title: "Salsa Bestial" });
    resolveRelease.mockResolvedValueOnce({ status: "matched", ids: matchedIds() });

    const outcome = await lookupResolutionForItem(item.id);
    expect(outcome).toEqual({ kind: "result", status: "matched", ids: matchedIds() });

    const [row] = await db.select().from(musicItems).where(eq(musicItems.id, item.id));
    expect(row.musicbrainzReleaseId).toBe("mb-1");
    expect(row.musicbrainzReleaseGroupId).toBe("rg-1");
    expect(row.musicbrainzArtistId).toBe("mba-1");
    expect(row.discogsReleaseId).toBe(4419535);
    expect(row.discogsMasterId).toBe(706722);
    expect(row.resolutionStatus).toBe("matched");
    expect(row.resolutionAttemptedAt).not.toBeNull();
  });

  test("asks the resolver with the row's artist, title and year", async () => {
    const item = await createRow({
      artistName: "Sally Oldfield",
      title: "Water Bearer",
      year: 1978,
    });
    resolveRelease.mockResolvedValueOnce({ status: "absent", ids: null });

    await lookupResolutionForItem(item.id);
    expect(resolveRelease).toHaveBeenCalledWith({
      artist: "Sally Oldfield",
      title: "Water Bearer",
      year: 1978,
    });
  });

  test("an absent verdict stamps status alone — and is terminal", async () => {
    const item = await createRow({ artistName: "Típico Santa Rosa", title: "Típico Santa Rosa" });
    resolveRelease.mockResolvedValue({ status: "absent", ids: null });

    const first = await lookupResolutionForItem(item.id);
    expect(first).toEqual({ kind: "result", status: "absent", ids: null });

    const [row] = await db.select().from(musicItems).where(eq(musicItems.id, item.id));
    expect(row.musicbrainzReleaseId).toBeNull();
    expect(row.discogsReleaseId).toBeNull();
    expect(row.resolutionStatus).toBe("absent");

    // Re-opening never re-asks a settled question.
    const second = await lookupResolutionForItem(item.id);
    expect(second).toEqual({ kind: "skipped", reason: "already_resolved" });
    expect(resolveRelease).toHaveBeenCalledTimes(1);
  });

  test("a failed attempt stays retryable once the cooldown passes", async () => {
    const item = await createRow({ artistName: "Failed Artist", title: "Throttled" });
    resolveRelease.mockResolvedValueOnce({
      status: "failed",
      ids: null,
      errors: [{ provider: "musicbrainz", message: "503" }],
    });

    const first = await lookupResolutionForItem(item.id);
    expect(first).toEqual({ kind: "result", status: "failed", ids: null });

    // The next open worth of patience later, the page may ask again.
    await db
      .update(musicItems)
      .set({ resolutionAttemptedAt: new Date(Date.now() - FAILED_RETRY_COOLDOWN_MS - 1000) })
      .where(eq(musicItems.id, item.id));
    resolveRelease.mockResolvedValueOnce({ status: "matched", ids: matchedIds() });
    const second = await lookupResolutionForItem(item.id);
    expect(second).toEqual({ kind: "result", status: "matched", ids: matchedIds() });

    const [row] = await db.select().from(musicItems).where(eq(musicItems.id, item.id));
    expect(row.resolutionStatus).toBe("matched");
    expect(row.musicbrainzReleaseId).toBe("mb-1");
  });

  test("a fresh failure is left alone — back/forward must not re-ask", async () => {
    const item = await createRow({ artistName: "Cooldown Artist", title: "Just Failed" });
    resolveRelease.mockResolvedValueOnce({
      status: "failed",
      ids: null,
      errors: [{ provider: "discogs", message: "429" }],
    });

    const first = await lookupResolutionForItem(item.id);
    expect(first).toEqual({ kind: "result", status: "failed", ids: null });

    const second = await lookupResolutionForItem(item.id);
    expect(second).toEqual({ kind: "skipped", reason: "recently_attempted" });
    expect(resolveRelease).toHaveBeenCalledTimes(1);
  });

  test("concurrent opens of the same release share one ask", async () => {
    const item = await createRow({ artistName: "Two Tabs", title: "One Ask" });
    let answer!: () => void;
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    resolveRelease.mockImplementationOnce(async () => {
      await held;
      return { status: "matched", ids: matchedIds() };
    });

    const first = lookupResolutionForItem(item.id);
    const second = lookupResolutionForItem(item.id);
    answer();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual({ kind: "result", status: "matched", ids: matchedIds() });
    expect(b).toEqual(a);
    expect(resolveRelease).toHaveBeenCalledTimes(1);
  });

  test("a throw reads as a failed attempt — stamped, retryable", async () => {
    const item = await createRow({ artistName: "Throwing Artist", title: "Boom" });
    resolveRelease.mockRejectedValueOnce(new Error("socket hang up"));

    const outcome = await lookupResolutionForItem(item.id);
    expect(outcome).toEqual({ kind: "result", status: "failed", ids: null });

    const [row] = await db.select().from(musicItems).where(eq(musicItems.id, item.id));
    expect(row.resolutionStatus).toBe("failed");
    expect(row.resolutionAttemptedAt).not.toBeNull();
  });

  test("a row with any stored id is skipped, whatever its status", async () => {
    const item = await createRow({
      artistName: "Artist Two",
      title: "Already Carries Ids",
      discogsReleaseId: 111111,
    });

    const outcome = await lookupResolutionForItem(item.id);
    expect(outcome).toEqual({ kind: "skipped", reason: "carries_ids" });
    expect(resolveRelease).not.toHaveBeenCalled();
  });

  test("a settled status is skipped even without ids", async () => {
    const item = await createRow({ artistName: "Partial Artist", title: "One Catalogue" });
    await db
      .update(musicItems)
      .set({ resolutionStatus: "partial" })
      .where(eq(musicItems.id, item.id));

    const outcome = await lookupResolutionForItem(item.id);
    expect(outcome).toEqual({ kind: "skipped", reason: "already_resolved" });
    expect(resolveRelease).not.toHaveBeenCalled();
  });

  test("a row without an artist is skipped — the resolver needs both halves", async () => {
    const item = await createRow({ title: "No Artist Here" });

    const outcome = await lookupResolutionForItem(item.id);
    expect(outcome).toEqual({ kind: "skipped", reason: "no_artist" });
    expect(resolveRelease).not.toHaveBeenCalled();
  });

  test("an untitled row is skipped", async () => {
    const item = await createRow({ artistName: "Untitled Artist", title: "Untitled" });

    const outcome = await lookupResolutionForItem(item.id);
    expect(outcome).toEqual({ kind: "skipped", reason: "untitled" });
    expect(resolveRelease).not.toHaveBeenCalled();
  });

  test("no-ops under OTB_DISABLE_EXTERNAL_LOOKUPS", async () => {
    const item = await createRow({ artistName: "Flagged Artist", title: "No Lookups" });
    process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";
    try {
      const outcome = await lookupResolutionForItem(item.id);
      expect(outcome).toEqual({ kind: "skipped", reason: "lookups_disabled" });
      expect(resolveRelease).not.toHaveBeenCalled();

      const [row] = await db.select().from(musicItems).where(eq(musicItems.id, item.id));
      expect(row.resolutionStatus).toBeNull();
    } finally {
      delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
    }
  });

  test("an artist MBID from another path is never overwritten", async () => {
    const item = await createRow({ artistName: "Identity Artist", title: "Confirmed Elsewhere" });
    // The artist-identity backfill stamped this; the resolver must not touch it.
    await db
      .update(musicItems)
      .set({ musicbrainzArtistId: "confirmed-mba" })
      .where(eq(musicItems.id, item.id));
    resolveRelease.mockResolvedValueOnce({
      status: "matched",
      ids: matchedIds({ musicbrainzArtistId: "resolver-guess-mba" }),
    });

    const outcome = await lookupResolutionForItem(item.id);
    expect(outcome.kind).toBe("result");

    const [row] = await db.select().from(musicItems).where(eq(musicItems.id, item.id));
    expect(row.musicbrainzArtistId).toBe("confirmed-mba");
    expect(row.discogsReleaseId).toBe(4419535);
  });

  test("a row that gained ids mid-resolution keeps them, not the resolver's", async () => {
    const item = await createRow({ artistName: "Racing Artist", title: "Won By Another Path" });
    // A live scan wrote an id while the resolver was asking — the write must
    // match nothing rather than overwrite the other path's provenance.
    resolveRelease.mockImplementationOnce(async () => {
      await db
        .update(musicItems)
        .set({ discogsReleaseId: 987654 })
        .where(eq(musicItems.id, item.id));
      return { status: "matched", ids: matchedIds() };
    });

    const outcome = await lookupResolutionForItem(item.id);
    expect(outcome).toEqual({ kind: "skipped", reason: "carries_ids" });

    const [row] = await db.select().from(musicItems).where(eq(musicItems.id, item.id));
    expect(row.discogsReleaseId).toBe(987654);
    expect(row.musicbrainzReleaseId).toBeNull();
    expect(row.resolutionStatus).toBeNull();
  });

  test("answers not_found for a release that doesn't exist", async () => {
    const outcome = await lookupResolutionForItem(999_999_999);
    expect(outcome).toEqual({ kind: "not_found" });
    expect(resolveRelease).not.toHaveBeenCalled();
  });
});

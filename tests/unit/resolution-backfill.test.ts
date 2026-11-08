import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../adapters/db/index";
import { musicItems } from "../../adapters/db/schema";
import { createMusicItemDirect } from "../../app/music-item-store";

// The sweep's contract: never-attempted or failed rows with no ids get
// resolved and stamped; absent is terminal, failed stays retryable, rows with
// ids from another path are left alone. The resolver itself is mocked — its
// quality is the eval's business, not this sweep's.

const ENV_BEFORE = {
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY,
  OTB_DISABLE_EXTERNAL_LOOKUPS: process.env.OTB_DISABLE_EXTERNAL_LOOKUPS,
};
process.env.MISTRAL_API_KEY = "test-key";
process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";

// Imported before mock.module so the real resolver can be handed back when
// this file is done — bun's mock.module() persists process-wide and mutates
// the imported namespace in place (see ingest.test.ts), so the real function
// has to be held by value; `() => realResolver` alone would restore the stub.
// Test files run in no guaranteed order, so release-resolver.test.ts (and any
// later importer of the real resolver) must not inherit these stubs.
import * as realResolver from "../../app/release-resolver";

const realResolveRelease = realResolver.resolveRelease;
const resolveRelease = mock((_query: unknown) => Promise.resolve({ status: "absent", ids: null }));

mock.module("../../app/release-resolver", () => ({
  ...realResolver,
  resolveRelease: (query: unknown) => resolveRelease(query),
}));

const { findResolutionBackfillRows, backfillResolutionForRow, runResolutionBackfill } =
  await import("../../app/resolution-backfill");

afterAll(() => {
  mock.module("../../app/release-resolver", () => ({
    ...realResolver,
    resolveRelease: realResolveRelease,
  }));
  for (const [key, value] of Object.entries(ENV_BEFORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterEach(() => {
  resolveRelease.mockClear();
});

async function statusOf(id: number): Promise<string | null> {
  const [row] = await db
    .select({ status: musicItems.resolutionStatus })
    .from(musicItems)
    .where(eq(musicItems.id, id));
  return row?.status ?? null;
}

describe("resolution backfill eligibility", () => {
  test("a plain un-resolved row with an artist is eligible", async () => {
    const { item } = await createMusicItemDirect({ artistName: "Artist One", title: "Plain Row" });
    const rows = await findResolutionBackfillRows(null);
    expect(rows.some((row) => row.id === item.id)).toBe(true);
  });

  test("a row with any stored id is never eligible, whatever its status", async () => {
    const { item } = await createMusicItemDirect({
      artistName: "Artist Two",
      title: "Already Carries Ids",
      discogsReleaseId: 111111,
    });
    const rows = await findResolutionBackfillRows(null);
    expect(rows.some((row) => row.id === item.id)).toBe(false);
  });

  test("a row without an artist is never eligible — the resolver needs both halves", async () => {
    const { item } = await createMusicItemDirect({ title: "No Artist Here" });
    const rows = await findResolutionBackfillRows(null);
    expect(rows.some((row) => row.id === item.id)).toBe(false);
  });

  test("absent rows drop out; failed rows stay in", async () => {
    const absent = await createMusicItemDirect({ artistName: "Absent Artist", title: "Nowhere" });
    await db
      .update(musicItems)
      .set({ resolutionStatus: "absent" })
      .where(eq(musicItems.id, absent.item.id));

    const failed = await createMusicItemDirect({ artistName: "Failed Artist", title: "Throttled" });
    await db
      .update(musicItems)
      .set({ resolutionStatus: "failed" })
      .where(eq(musicItems.id, failed.item.id));

    const rows = await findResolutionBackfillRows(null);
    expect(rows.some((row) => row.id === absent.item.id)).toBe(false);
    expect(rows.some((row) => row.id === failed.item.id)).toBe(true);
  });
});

describe("backfillResolutionForRow", () => {
  test("a matched outcome writes the ids and the status", async () => {
    const { item } = await createMusicItemDirect({
      artistName: "Orquesta El Macabeo",
      title: "Salsa Bestial",
    });
    resolveRelease.mockResolvedValueOnce({
      status: "matched",
      ids: {
        musicbrainzReleaseId: "mb-1",
        musicbrainzReleaseGroupId: "rg-1",
        musicbrainzArtistId: "mba-1",
        discogsReleaseId: 4419535,
        discogsMasterId: 706722,
        confidence: 0.95,
      },
    });

    const status = await backfillResolutionForRow({
      id: item.id,
      title: item.title,
      artist: "Orquesta El Macabeo",
      year: null,
    });
    expect(status).toBe("matched");

    const [row] = await db.select().from(musicItems).where(eq(musicItems.id, item.id));
    expect(row.musicbrainzReleaseId).toBe("mb-1");
    expect(row.musicbrainzReleaseGroupId).toBe("rg-1");
    expect(row.musicbrainzArtistId).toBe("mba-1");
    expect(row.discogsReleaseId).toBe(4419535);
    expect(row.discogsMasterId).toBe(706722);
    expect(row.resolutionStatus).toBe("matched");
    expect(row.resolutionAttemptedAt).not.toBeNull();
  });

  test("an absent outcome stamps the verdict and nothing else", async () => {
    const { item } = await createMusicItemDirect({
      artistName: "Típico Santa Rosa",
      title: "Típico Santa Rosa",
    });
    resolveRelease.mockResolvedValueOnce({ status: "absent", ids: null });

    const status = await backfillResolutionForRow({
      id: item.id,
      title: item.title,
      artist: "Típico Santa Rosa",
      year: null,
    });
    expect(status).toBe("absent");

    const [row] = await db.select().from(musicItems).where(eq(musicItems.id, item.id));
    expect(row.discogsReleaseId).toBeNull();
    expect(row.resolutionStatus).toBe("absent");
    expect(row.resolutionAttemptedAt).not.toBeNull();
  });

  test("a throw reads as a failed attempt — stamped, retryable, sweep continues", async () => {
    // Drain every other eligible row to absent (terminal) first, so the sweep
    // below has exactly one row to touch and the one-shot rejection lands on it.
    resolveRelease.mockResolvedValue({ status: "absent", ids: null });
    await runResolutionBackfill(null, 0);

    const { item } = await createMusicItemDirect({ artistName: "Throwing Artist", title: "Boom" });
    resolveRelease.mockRejectedValueOnce(new Error("socket hang up"));

    const summary = await runResolutionBackfill(null, 0);
    expect(summary.processed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(await statusOf(item.id)).toBe("failed");
  });
});

describe("runResolutionBackfill", () => {
  test("processes every eligible row once and counts the verdicts", async () => {
    await createMusicItemDirect({ artistName: "Counted Artist", title: "One" });
    resolveRelease.mockResolvedValue({ status: "absent", ids: null });

    const seen: number[] = [];
    const summary = await runResolutionBackfill(null, 0, (row) => seen.push(row.id));

    expect(seen.length).toBe(summary.processed);
    expect(summary.absent).toBeGreaterThan(0);
    expect(summary.processed).toBe(
      summary.matched + summary.partial + summary.absent + summary.failed,
    );
  });
});

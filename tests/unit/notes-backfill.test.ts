import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
// Held before mock.module below so the real resolver can be handed back when
// this file is done — bun's mock.module() persists process-wide (see
// fetch-page.test.ts).
import * as realDns from "node:dns/promises";
import { db } from "../../adapters/db/index";
import { musicItems } from "../../adapters/db/schema";
import { createMusicItemDirect } from "../../app/music-item-store";
import {
  countNotesBackfillEligible,
  findNotesBackfillRows,
  runNotesBackfill,
} from "../../app/notes-backfill";

// The sweep's contract: never-attempted rows with a MusicBrainz id and notes
// to fill get enriched and stamped; prose notes and id-less rows are left
// alone; a MusicBrainz failure stays retryable. The network is mocked at the
// fetch boundary — MusicBrainz answers url-rels, the link's page answers HTML.

const ENV_BEFORE = {
  OTB_DISABLE_EXTERNAL_LOOKUPS: process.env.OTB_DISABLE_EXTERNAL_LOOKUPS,
};
process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";

// The sweep runs the enrichment's default wiring, and the page fetch resolves
// the host before connecting (publicHostsOnly). The resolver is mocked
// alongside fetch so the suite never touches live DNS — offline, or on a
// DNS-blocked runner, the sweep must behave exactly the same.
const realLookup = realDns.lookup;
const lookupMock = mock(async () => [{ address: "93.184.216.34", family: 4 }]);
mock.module("node:dns/promises", () => ({ ...realDns, lookup: lookupMock }));

afterAll(() => {
  mock.module("node:dns/promises", () => ({ ...realDns, lookup: realLookup }));
  for (const [key, value] of Object.entries(ENV_BEFORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const WIKI_URL = "https://en.wikipedia.org/wiki/In_Rainbows";
const PARAGRAPH = "In Rainbows is the seventh studio album by Radiohead.";

function mockNetwork(fetchImpl: (url: string) => Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return fetchImpl(url);
  }) as typeof fetch);
}

function happyNetwork() {
  return mockNetwork(async (url) => {
    if (url.startsWith("https://musicbrainz.org/")) {
      return Response.json({
        relations: [{ type: "wikipedia", url: { resource: WIKI_URL } }],
      });
    }
    return new Response(`<div class="mw-parser-output"><p>${PARAGRAPH}</p></div>`, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });
}

/**
 * The unit suite shares one database; rows other files created must not join
 * this sweep. The attempt marker is this feature's own column — settling
 * every pre-existing row is invisible to the rest of the suite.
 */
async function settleExistingRows(): Promise<void> {
  await db.update(musicItems).set({ notesEnrichmentAttemptedAt: new Date() });
}

async function notesOf(id: number): Promise<string | null> {
  const [row] = await db
    .select({ notes: musicItems.notes })
    .from(musicItems)
    .where(eq(musicItems.id, id));
  return row?.notes ?? null;
}

describe("notes backfill eligibility", () => {
  test("a never-attempted row with a MusicBrainz id and empty notes is eligible", async () => {
    const { item } = await createMusicItemDirect({
      artistName: "Backfill Artist",
      title: "Empty Notes",
      musicbrainzReleaseGroupId: "rg-bf-eligible",
    });
    const rows = await findNotesBackfillRows(null);
    expect(rows.some((row) => row.id === item.id)).toBe(true);
  });

  test("a short note stays eligible — the paragraph lands beneath it", async () => {
    const { item } = await createMusicItemDirect({
      artistName: "Backfill Artist",
      title: "Short Notes",
      musicbrainzReleaseGroupId: "rg-bf-short",
      notes: "love this one",
    });
    const rows = await findNotesBackfillRows(null);
    expect(rows.some((row) => row.id === item.id)).toBe(true);
  });

  test("prose notes are never eligible", async () => {
    const { item } = await createMusicItemDirect({
      artistName: "Backfill Artist",
      title: "Prose Notes",
      musicbrainzReleaseGroupId: "rg-bf-prose",
      notes: "Bought at Rough Trade.",
    });
    const rows = await findNotesBackfillRows(null);
    expect(rows.some((row) => row.id === item.id)).toBe(false);
  });

  test("a row with no MusicBrainz id is never eligible — nothing to ask about", async () => {
    const { item } = await createMusicItemDirect({
      artistName: "Backfill Artist",
      title: "No Ids",
    });
    const rows = await findNotesBackfillRows(null);
    expect(rows.some((row) => row.id === item.id)).toBe(false);
  });

  test("an attempted row drops out, hit or miss", async () => {
    const { item } = await createMusicItemDirect({
      artistName: "Backfill Artist",
      title: "Already Attempted",
      musicbrainzReleaseGroupId: "rg-bf-attempted",
    });
    await db
      .update(musicItems)
      .set({ notesEnrichmentAttemptedAt: new Date() })
      .where(eq(musicItems.id, item.id));
    const rows = await findNotesBackfillRows(null);
    expect(rows.some((row) => row.id === item.id)).toBe(false);
  });

  test("the limit applies after the prose filter", async () => {
    const rows = await findNotesBackfillRows(1);
    expect(rows.length).toBeLessThanOrEqual(1);
  });
});

describe("runNotesBackfill", () => {
  test("the sweep ingests the paragraph and stamps every row it processes", async () => {
    await settleExistingRows();
    const first = await createMusicItemDirect({
      artistName: "Radiohead",
      title: "In Rainbows",
      musicbrainzReleaseGroupId: "rg-bf-sweep-1",
    });
    const second = await createMusicItemDirect({
      artistName: "Radiohead",
      title: "In Rainbows Short",
      musicbrainzReleaseGroupId: "rg-bf-sweep-2",
      notes: "love this one",
    });

    const fetchSpy = happyNetwork();
    try {
      const summary = await runNotesBackfill(null, 0);
      expect(summary.processed).toBe(2);
      expect(summary.written).toBe(2);
      expect(summary.failed).toBe(0);

      // The page fetch went through the public-address gate, not around it:
      // the default wiring resolves the host before connecting.
      expect(lookupMock.mock.calls.some(([host]) => host === "en.wikipedia.org")).toBe(true);

      expect(await notesOf(first.item.id)).toBe(`${PARAGRAPH} — From Wikipedia (${WIKI_URL})`);
      expect(await notesOf(second.item.id)).toBe(
        `love this one\n\n${PARAGRAPH} — From Wikipedia (${WIKI_URL})`,
      );

      // Both rows are settled — a re-run finds nothing.
      expect(await countNotesBackfillEligible()).toBe(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("a MusicBrainz failure counts as failed and stays retryable", async () => {
    await settleExistingRows();
    const { item } = await createMusicItemDirect({
      artistName: "Radiohead",
      title: "Throttled Record",
      musicbrainzReleaseGroupId: "rg-bf-failed",
    });

    const fetchSpy = mockNetwork(async (url) => {
      if (url.startsWith("https://musicbrainz.org/")) {
        throw new Error("connection reset");
      }
      return new Response("unused", { headers: { "content-type": "text/html" } });
    });
    try {
      const summary = await runNotesBackfill(null, 0);
      expect(summary.processed).toBe(1);
      expect(summary.failed).toBe(1);
      expect(summary.written).toBe(0);

      const [row] = await db
        .select({ attemptedAt: musicItems.notesEnrichmentAttemptedAt })
        .from(musicItems)
        .where(eq(musicItems.id, item.id));
      expect(row.attemptedAt).toBeNull();
      expect(await countNotesBackfillEligible()).toBe(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("a page that never answers settles as a miss, not a failure", async () => {
    await settleExistingRows();
    const { item } = await createMusicItemDirect({
      artistName: "Radiohead",
      title: "Unreachable Page",
      musicbrainzReleaseGroupId: "rg-bf-unreachable",
    });

    const fetchSpy = mockNetwork(async (url) => {
      if (url.startsWith("https://musicbrainz.org/")) {
        return Response.json({
          relations: [{ type: "wikipedia", url: { resource: WIKI_URL } }],
        });
      }
      return new Response(null, { status: 403 });
    });
    try {
      const summary = await runNotesBackfill(null, 0);
      expect(summary.processed).toBe(1);
      expect(summary.noParagraph).toBe(1);
      expect(summary.failed).toBe(0);
      expect(await notesOf(item.id)).toBeNull();
      expect(await countNotesBackfillEligible()).toBe(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

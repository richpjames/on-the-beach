import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../adapters/db/index";
import { externalLinkSources, musicItems } from "../../adapters/db/schema";
import { createMusicItemDirect } from "../../app/music-item-store";
import {
  defaultNotesEnrichmentDeps,
  enrichNotesForItem,
  fetchItemForNotesEnrichment,
  getLinkSourceRanks,
  listLinkSources,
  recordLinkSource,
  setLinkSourceRank,
  stampNotesEnrichment,
  writeEnrichedNotes,
  type ItemForNotesEnrichment,
  type NotesEnrichmentDeps,
} from "../../app/notes-enrichment";
import type { MbUrlRelation } from "../../adapters/musicbrainz/index";

// The enrichment's contract: the best-ranked external link supplies the
// paragraph, the notes rules decide what it may overwrite, and the attempt
// marker settles the item on every outcome but a MusicBrainz failure. The
// network is injected — its behaviour is the orchestration's business here.

const ENV_BEFORE = {
  OTB_DISABLE_EXTERNAL_LOOKUPS: process.env.OTB_DISABLE_EXTERNAL_LOOKUPS,
};
// The creation hook fires background enrichment; under test it must no-op.
process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";

afterAll(() => {
  for (const [key, value] of Object.entries(ENV_BEFORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterEach(async () => {
  await db.delete(externalLinkSources);
});

const WIKI_URL = "https://en.wikipedia.org/wiki/In_Rainbows";
const PITCHFORK_URL = "https://pitchfork.com/reviews/albums/10785-in-rainbows/";
const GUARDIAN_URL = "https://www.theguardian.com/music/2007/oct/10/radiohead";

function item(overrides: Partial<ItemForNotesEnrichment> = {}): ItemForNotesEnrichment {
  return {
    id: 1,
    notes: null,
    notesEnrichmentAttemptedAt: null,
    musicbrainzReleaseId: null,
    musicbrainzReleaseGroupId: "group-1",
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<NotesEnrichmentDeps> = {}): NotesEnrichmentDeps {
  return {
    fetchItem: mock(async () => item()),
    resolveGroupId: mock(async () => "group-1"),
    fetchUrlRelations: mock(async () => [{ type: "wikipedia", url: WIKI_URL }]),
    recordSource: mock(async () => {}),
    getRanks: mock(async () => new Map<string, number>()),
    fetchHtml: mock(async () => "<p>the page</p>"),
    extractParagraph: mock(() => "A paragraph."),
    writeNotes: mock(async () => true),
    stamp: mock(async () => {}),
    ...overrides,
  };
}

describe("enrichNotesForItem — skip rules", () => {
  test("a missing item is not_found", async () => {
    const deps = fakeDeps({ fetchItem: mock(async () => null) });
    expect(await enrichNotesForItem(99, deps)).toEqual({ kind: "not_found" });
  });

  test("an already-attempted item is never re-fetched", async () => {
    const deps = fakeDeps({
      fetchItem: mock(async () => item({ notesEnrichmentAttemptedAt: new Date() })),
    });
    expect(await enrichNotesForItem(1, deps)).toEqual({
      kind: "skipped",
      reason: "already_attempted",
    });
    expect(deps.fetchUrlRelations).not.toHaveBeenCalled();
  });

  test("notes that already read as prose are left alone, and stamped", async () => {
    const deps = fakeDeps({
      fetchItem: mock(async () => item({ notes: "Bought at Rough Trade." })),
    });
    expect(await enrichNotesForItem(1, deps)).toEqual({
      kind: "skipped",
      reason: "notes_complete",
    });
    expect(deps.stamp).toHaveBeenCalledWith(1);
    expect(deps.fetchUrlRelations).not.toHaveBeenCalled();
  });

  test("an item with no MusicBrainz ids is left unstamped for a later pass", async () => {
    const deps = fakeDeps({
      fetchItem: mock(async () =>
        item({ musicbrainzReleaseGroupId: null, musicbrainzReleaseId: null }),
      ),
    });
    expect(await enrichNotesForItem(1, deps)).toEqual({
      kind: "skipped",
      reason: "no_musicbrainz_id",
    });
    expect(deps.stamp).not.toHaveBeenCalled();
    expect(deps.resolveGroupId).not.toHaveBeenCalled();
  });
});

describe("enrichNotesForItem — finding the links", () => {
  test("a release id is resolved to its group when no group is stored", async () => {
    const deps = fakeDeps({
      fetchItem: mock(async () =>
        item({ musicbrainzReleaseGroupId: null, musicbrainzReleaseId: "rel-1" }),
      ),
      resolveGroupId: mock(async () => "group-9"),
    });
    await enrichNotesForItem(1, deps);
    expect(deps.resolveGroupId).toHaveBeenCalledWith("rel-1");
    expect(deps.fetchUrlRelations).toHaveBeenCalledWith("group-9");
  });

  test("a release with no group settles as a miss", async () => {
    const deps = fakeDeps({
      fetchItem: mock(async () =>
        item({ musicbrainzReleaseGroupId: null, musicbrainzReleaseId: "rel-1" }),
      ),
      resolveGroupId: mock(async () => null),
    });
    expect(await enrichNotesForItem(1, deps)).toEqual({
      kind: "result",
      notes: null,
      source: null,
    });
    expect(deps.stamp).toHaveBeenCalledWith(1);
  });

  test("a MusicBrainz failure stays retryable — no stamp", async () => {
    const deps = fakeDeps({
      fetchUrlRelations: mock(async () => {
        throw new Error("503");
      }),
    });
    expect(await enrichNotesForItem(1, deps)).toEqual({
      kind: "skipped",
      reason: "lookup_failed",
    });
    expect(deps.stamp).not.toHaveBeenCalled();
  });

  test("every host met is recorded, not just the winner", async () => {
    const deps = fakeDeps({
      fetchUrlRelations: mock(async () => [
        { type: "wikipedia", url: WIKI_URL },
        { type: "review", url: PITCHFORK_URL },
        { type: "official", url: GUARDIAN_URL },
      ]),
    });
    await enrichNotesForItem(1, deps);
    expect(deps.recordSource).toHaveBeenCalledTimes(3);
    expect(deps.recordSource).toHaveBeenCalledWith("wikipedia.org", "Wikipedia");
    expect(deps.recordSource).toHaveBeenCalledWith("pitchfork.com", "Pitchfork");
    expect(deps.recordSource).toHaveBeenCalledWith("theguardian.com", "theguardian.com");
  });

  test("unusable relation URLs are skipped", async () => {
    const deps = fakeDeps({
      fetchUrlRelations: mock(async () => [{ type: "other", url: "not a url" }]),
    });
    expect(await enrichNotesForItem(1, deps)).toEqual({
      kind: "result",
      notes: null,
      source: null,
    });
    expect(deps.recordSource).not.toHaveBeenCalled();
    expect(deps.fetchHtml).not.toHaveBeenCalled();
    expect(deps.stamp).toHaveBeenCalledWith(1);
  });

  test("no relations at all settles as a miss", async () => {
    const deps = fakeDeps({ fetchUrlRelations: mock(async () => []) });
    expect(await enrichNotesForItem(1, deps)).toEqual({
      kind: "result",
      notes: null,
      source: null,
    });
    expect(deps.stamp).toHaveBeenCalledWith(1);
  });
});

describe("enrichNotesForItem — picking by rank", () => {
  const relations: MbUrlRelation[] = [
    { type: "review", url: PITCHFORK_URL },
    { type: "wikipedia", url: WIKI_URL },
  ];

  test("the highest default rank wins, whatever MusicBrainz's order", async () => {
    const deps = fakeDeps({ fetchUrlRelations: mock(async () => relations) });
    await enrichNotesForItem(1, deps);
    expect(deps.fetchHtml).toHaveBeenCalledWith(WIKI_URL);
  });

  test("the user's ranking outranks the defaults", async () => {
    const deps = fakeDeps({
      fetchUrlRelations: mock(async () => [...relations, { type: "review", url: GUARDIAN_URL }]),
      getRanks: mock(async () => new Map([["theguardian.com", 50]])),
    });
    await enrichNotesForItem(1, deps);
    expect(deps.fetchHtml).toHaveBeenCalledWith(GUARDIAN_URL);
  });

  test("a tie keeps MusicBrainz's own ordering", async () => {
    const deps = fakeDeps({
      fetchUrlRelations: mock(async () => [
        { type: "official", url: GUARDIAN_URL },
        { type: "other", url: "https://www.nme.com/reviews/radiohead-in-rainbows" },
      ]),
    });
    await enrichNotesForItem(1, deps);
    expect(deps.fetchHtml).toHaveBeenCalledWith(GUARDIAN_URL);
  });

  test("a rank-0 link is still fetched when nothing better is attached", async () => {
    const deps = fakeDeps({
      fetchUrlRelations: mock(async () => [{ type: "official", url: GUARDIAN_URL }]),
    });
    const outcome = await enrichNotesForItem(1, deps);
    expect(deps.fetchHtml).toHaveBeenCalledWith(GUARDIAN_URL);
    expect(outcome.kind).toBe("result");
  });
});

describe("enrichNotesForItem — writing the notes", () => {
  test("an unreachable page settles as a miss", async () => {
    const deps = fakeDeps({ fetchHtml: mock(async () => null) });
    expect(await enrichNotesForItem(1, deps)).toEqual({
      kind: "result",
      notes: null,
      source: null,
    });
    expect(deps.writeNotes).not.toHaveBeenCalled();
    expect(deps.stamp).toHaveBeenCalledWith(1);
  });

  test("a page with no extractable paragraph settles as a miss", async () => {
    const deps = fakeDeps({ extractParagraph: mock(() => null) });
    expect(await enrichNotesForItem(1, deps)).toEqual({
      kind: "result",
      notes: null,
      source: null,
    });
    expect(deps.writeNotes).not.toHaveBeenCalled();
    expect(deps.stamp).toHaveBeenCalledWith(1);
  });

  test("empty notes take the paragraph with its provenance line", async () => {
    const deps = fakeDeps();
    const outcome = await enrichNotesForItem(1, deps);
    expect(deps.writeNotes).toHaveBeenCalledWith(
      1,
      `A paragraph. — From Wikipedia (${WIKI_URL})`,
      null,
    );
    expect(outcome).toEqual({
      kind: "result",
      notes: `A paragraph. — From Wikipedia (${WIKI_URL})`,
      source: { displayName: "Wikipedia", url: WIKI_URL },
    });
    expect(deps.stamp).toHaveBeenCalledWith(1);
  });

  test("a short note keeps its place above the ingested paragraph", async () => {
    const deps = fakeDeps({ fetchItem: mock(async () => item({ notes: "love this one" })) });
    await enrichNotesForItem(1, deps);
    expect(deps.writeNotes).toHaveBeenCalledWith(
      1,
      `love this one\n\nA paragraph. — From Wikipedia (${WIKI_URL})`,
      "love this one",
    );
  });

  test("a note typed mid-fetch outranks the ingestion — the guarded write misses", async () => {
    const deps = fakeDeps({ writeNotes: mock(async () => false) });
    expect(await enrichNotesForItem(1, deps)).toEqual({
      kind: "result",
      notes: null,
      source: null,
    });
    expect(deps.stamp).toHaveBeenCalledWith(1);
  });
});

describe("link-source rankings in the database", () => {
  test("a newly met host arrives with its default rank", async () => {
    await recordLinkSource("wikipedia.org", "Wikipedia");
    await recordLinkSource("pitchfork.com", "Pitchfork");
    await recordLinkSource("example-a.test", "example-a.test");
    const ranks = await getLinkSourceRanks();
    expect(ranks.get("wikipedia.org")).toBe(11);
    expect(ranks.get("pitchfork.com")).toBe(10);
    expect(ranks.get("example-a.test")).toBe(0);
  });

  test("recording a host again never overwrites the user's rank", async () => {
    await recordLinkSource("example-b.test", "example-b.test");
    await setLinkSourceRank("example-b.test", 42);
    await recordLinkSource("example-b.test", "example-b.test");
    expect((await getLinkSourceRanks()).get("example-b.test")).toBe(42);
  });

  test("the list reads best-ranked first, ties by name", async () => {
    await recordLinkSource("example-c.test", "Zebra");
    await recordLinkSource("example-d.test", "Aardvark");
    await setLinkSourceRank("example-c.test", 5);
    const rows = await listLinkSources();
    const hosts = rows.map((row) => row.host);
    expect(hosts.indexOf("example-c.test")).toBeLessThan(hosts.indexOf("example-d.test"));
  });

  test("re-ranking an unmet host is refused", async () => {
    expect(await setLinkSourceRank("never-met.test", 3)).toBe(false);
  });
});

describe("the guarded notes write", () => {
  test("a write lands only while the row holds what the enrichment read", async () => {
    const { item: created } = await createMusicItemDirect({
      artistName: "Notes Artist",
      title: "Guarded Write",
    });
    expect(await writeEnrichedNotes(created.id, "ingested", null)).toBe(true);
    // The row now holds "ingested"; a second enrichment that read null misses.
    expect(await writeEnrichedNotes(created.id, "stale", null)).toBe(false);
    // One that read the current value lands.
    expect(await writeEnrichedNotes(created.id, "fresh", "ingested")).toBe(true);

    const [row] = await db
      .select({ notes: musicItems.notes })
      .from(musicItems)
      .where(eq(musicItems.id, created.id));
    expect(row.notes).toBe("fresh");
  });

  test("the attempt marker round-trips through the item fetch", async () => {
    const { item: created } = await createMusicItemDirect({
      artistName: "Notes Artist",
      title: "Marker Round Trip",
    });
    expect((await fetchItemForNotesEnrichment(created.id))?.notesEnrichmentAttemptedAt).toBeNull();
    await stampNotesEnrichment(created.id);
    const fetched = await fetchItemForNotesEnrichment(created.id);
    expect(fetched?.notesEnrichmentAttemptedAt).toBeInstanceOf(Date);
  });
});

describe("enrichNotesForItem — against the database", () => {
  test("a full pass writes the notes, stamps the item and records the sources", async () => {
    const { item: created } = await createMusicItemDirect({
      artistName: "Radiohead",
      title: "In Rainbows",
      musicbrainzReleaseGroupId: "group-integration",
      notes: "love this one",
    });

    const deps: NotesEnrichmentDeps = {
      ...defaultNotesEnrichmentDeps,
      fetchUrlRelations: async () => [
        { type: "review", url: PITCHFORK_URL },
        { type: "wikipedia", url: WIKI_URL },
      ],
      fetchHtml: async () => "<p>the page</p>",
      extractParagraph: () => "In Rainbows is the seventh studio album by Radiohead.",
    };

    const outcome = await enrichNotesForItem(created.id, deps);
    expect(outcome.kind).toBe("result");

    const [row] = await db
      .select({
        notes: musicItems.notes,
        attemptedAt: musicItems.notesEnrichmentAttemptedAt,
      })
      .from(musicItems)
      .where(eq(musicItems.id, created.id));
    expect(row.notes).toBe(
      "love this one\n\nIn Rainbows is the seventh studio album by Radiohead. — " +
        `From Wikipedia (${WIKI_URL})`,
    );
    expect(row.attemptedAt).toBeInstanceOf(Date);

    const ranks = await getLinkSourceRanks();
    expect(ranks.get("wikipedia.org")).toBe(11);
    expect(ranks.get("pitchfork.com")).toBe(10);

    // A second pass is settled — the marker skips it.
    expect(await enrichNotesForItem(created.id, deps)).toEqual({
      kind: "skipped",
      reason: "already_attempted",
    });
  });
});

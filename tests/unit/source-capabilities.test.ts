import { afterEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { db } from "../../adapters/db/index";
import { musicItems, musicLinks, sources } from "../../adapters/db/schema";
import { SEED_SOURCES } from "../../adapters/db/seed-sources";
import { fetchFullItem } from "../../app/music-item-store";

// What a source lets you *do* with a record — play it, buy it, or read about it
// — as opposed to which service it is. The flags live on the `sources` table so
// they can be corrected without a deploy, which means the seed list and the
// database are two places that can disagree; these tests pin both, and the gap
// between them.

const insertedItemIds: number[] = [];

afterEach(async () => {
  if (insertedItemIds.length === 0) return;
  const ids = insertedItemIds.splice(0);
  await db.delete(musicLinks).where(inArray(musicLinks.musicItemId, ids));
  await db.delete(musicItems).where(inArray(musicItems.id, ids));
});

async function insertItemWithLink(sourceId: number | null): Promise<number> {
  const [item] = await db
    .insert(musicItems)
    .values({
      title: "Where Between You & Me",
      normalizedTitle: "where between you & me",
      listenStatus: "to-listen",
    })
    .returning({ id: musicItems.id });

  insertedItemIds.push(item.id);

  await db.insert(musicLinks).values({
    musicItemId: item.id,
    sourceId,
    url: `https://example.test/${item.id}`,
    isPrimary: true,
  });

  return item.id;
}

async function sourceIdFor(name: string): Promise<number> {
  const [row] = await db.select({ id: sources.id }).from(sources).where(eq(sources.name, name));
  return row.id;
}

describe("source capabilities — seeding", () => {
  test("every seeded source reaches the database with its classification intact", async () => {
    const rows = await db
      .select({
        name: sources.name,
        canPlay: sources.canPlay,
        canBuy: sources.canBuy,
        isEditorial: sources.isEditorial,
      })
      .from(sources);

    const byName = new Map(rows.map((r) => [r.name, r]));

    for (const seed of SEED_SOURCES) {
      expect(byName.get(seed.name)).toEqual({
        name: seed.name,
        canPlay: seed.canPlay,
        canBuy: seed.canBuy,
        isEditorial: seed.isEditorial,
      });
    }
  });

  // The distinction this whole column set exists for: both are places a release
  // turns up, but only one of them plays it.
  test("a service that hosts music is playable; a magazine is editorial", async () => {
    const rows = await db
      .select({
        name: sources.name,
        canPlay: sources.canPlay,
        isEditorial: sources.isEditorial,
      })
      .from(sources)
      .where(inArray(sources.name, ["apple_music", "pitchfork"]));

    const byName = new Map(rows.map((r) => [r.name, r]));

    expect(byName.get("apple_music")).toMatchObject({ canPlay: true, isEditorial: false });
    expect(byName.get("pitchfork")).toMatchObject({ canPlay: false, isEditorial: true });
  });

  // Discogs is the reason these are three independent flags and not one role:
  // it is neither somewhere you listen nor somewhere you read.
  test("a marketplace sells without playing or discussing", async () => {
    const [discogs] = await db
      .select({
        canPlay: sources.canPlay,
        canBuy: sources.canBuy,
        isEditorial: sources.isEditorial,
      })
      .from(sources)
      .where(eq(sources.name, "discogs"));

    expect(discogs).toEqual({ canPlay: false, canBuy: true, isEditorial: false });
  });

  test("no seeded source claims to both carry a record and write about it", () => {
    const contradictory = SEED_SOURCES.filter((s) => s.canPlay && s.isEditorial);
    expect(contradictory).toEqual([]);
  });
});

describe("source capabilities — reaching an item's links", () => {
  test("a link carries its source's capabilities", async () => {
    const id = await insertItemWithLink(await sourceIdFor("pitchfork"));

    const item = await fetchFullItem(id);

    expect(item?.links[0]).toMatchObject({
      source_name: "pitchfork",
      can_play: false,
      can_buy: false,
      is_editorial: true,
    });
  });

  // The source join is a LEFT one: a link to somewhere we don't model has no
  // row to read, and must promise nothing rather than defaulting to playable.
  test("a link on an unmodelled source promises nothing", async () => {
    const id = await insertItemWithLink(null);

    const item = await fetchFullItem(id);

    expect(item?.links[0]).toMatchObject({
      source_name: null,
      can_play: false,
      can_buy: false,
      is_editorial: false,
    });
  });
});

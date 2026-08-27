import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/db/index";
import {
  artistReleases,
  artists,
  musicItems,
  musicLinks,
  releaseAlerts,
  sources,
} from "../../server/db/schema";
import { normalize } from "../../server/utils";
import { processReminders } from "../../server/reminders";
import type { ReleaseLinkOutcome } from "../../server/release-link-check";

// ---------------------------------------------------------------------------
// Release day for a record filed from an alert: the link check the accept path
// couldn't make (nobody carries an album that isn't out) happens here.
// ---------------------------------------------------------------------------

// Deliberately far in the past. `bun test` runs every file in one process
// against one database, and this file drives the reminder cron: dating its
// fixtures to 2020 means a sweep here can never pick up another file's
// leftover reminder, which is stamped around the real clock.
const NOW = new Date("2020-01-05T09:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const FOUND: ReleaseLinkOutcome = {
  kind: "found",
  link: {
    url: "https://music.apple.com/gb/album/released-record/1",
    sourceName: "apple_music",
    via: "provider",
    foundBy: "Apple Music",
    artworkUrl: "https://example.test/cover.jpg",
    service: "apple_music",
    providerSearched: true,
  },
};

const NONE: ReleaseLinkOutcome = { kind: "none", service: "apple_music", providerSearched: true };

let sequence = 0;

interface Fixture {
  itemId: number;
}

/** A scheduled item whose reminder is due, optionally filed from an alert. */
async function makeDueItem(
  options: {
    fromAlert?: boolean;
    firstReleaseDate?: string;
    url?: string;
    remindAt?: Date;
  } = {},
): Promise<Fixture> {
  sequence += 1;
  const name = `Reminder Artist ${Date.now()}-${sequence}`;
  const title = `Reminder Record ${sequence}`;

  const [artist] = await db
    .insert(artists)
    .values({ name, normalizedName: normalize(name) })
    .returning({ id: artists.id });

  const [item] = await db
    .insert(musicItems)
    .values({
      title,
      normalizedTitle: normalize(title),
      artistId: artist.id,
      listenStatus: "to-listen",
      remindAt: options.remindAt ?? new Date(NOW.getTime() - 60_000),
      reminderPending: false,
    })
    .returning({ id: musicItems.id });

  if (options.url) {
    await db.insert(musicLinks).values({ musicItemId: item.id, url: options.url });
  }

  if (options.fromAlert !== false) {
    const [release] = await db
      .insert(artistReleases)
      .values({
        artistId: artist.id,
        mbReleaseGroupId: `rg-reminder-${sequence}`,
        title,
        normalizedTitle: normalize(title),
        primaryType: "Album",
        secondaryTypes: "[]",
        firstReleaseDate: options.firstReleaseDate ?? "2020-01-05",
        firstReleaseYear: 2020,
      })
      .returning({ id: artistReleases.id });

    await db.insert(releaseAlerts).values({
      artistId: artist.id,
      artistReleaseId: release.id,
      status: "added",
      reason: "announced",
      musicItemId: item.id,
    });
  }

  created.push({ itemId: item.id, artistId: artist.id });
  return { itemId: item.id };
}

function itemRow(id: number) {
  return db.select().from(musicItems).where(eq(musicItems.id, id)).get();
}

const created: Array<{ itemId: number; artistId: number }> = [];

beforeEach(() => {
  // The gate is driven through the injected checker; this only keeps the
  // background enrichment fired on publish from reaching the network.
  process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";
});

// Held rows keep a live reminder, and a later file's cron run — with the real
// checker and the real clock — would sweep them up. Take them with us.
afterEach(async () => {
  for (const { itemId, artistId } of created) {
    await db.delete(releaseAlerts).where(eq(releaseAlerts.musicItemId, itemId));
    await db.delete(artistReleases).where(eq(artistReleases.artistId, artistId));
    await db.delete(musicItems).where(eq(musicItems.id, itemId));
    await db.delete(artists).where(eq(artists.id, artistId));
  }
  created.length = 0;
});

describe("processReminders — the release-day link check", () => {
  test("files the link found on release day and lets the record through", async () => {
    const { itemId } = await makeDueItem();

    await processReminders(NOW, async () => FOUND);

    const item = await itemRow(itemId);
    expect(item?.listenStatus).toBe("to-listen");
    expect(item?.remindAt).toBeNull();
    expect(item?.reminderPending).toBe(true);
    expect(item?.artworkUrl).toBe("https://example.test/cover.jpg");

    const links = await db
      .select({ url: musicLinks.url, source: sources.name })
      .from(musicLinks)
      .leftJoin(sources, eq(musicLinks.sourceId, sources.id))
      .where(eq(musicLinks.musicItemId, itemId));
    expect(links).toEqual([
      { url: "https://music.apple.com/gb/album/released-record/1", source: "apple_music" },
    ]);
  });

  test("holds a record nobody carries yet, and asks again a week later", async () => {
    const { itemId } = await makeDueItem();

    await processReminders(NOW, async () => NONE);

    const item = await itemRow(itemId);
    // Still Scheduled — it just isn't due again until next week.
    expect(item?.reminderPending).toBe(false);
    expect(item?.remindAt?.getTime()).toBe(NOW.getTime() + 7 * DAY_MS);
  });

  test("a check that didn't complete is retried tomorrow rather than next week", async () => {
    const { itemId } = await makeDueItem();

    await processReminders(NOW, async () => ({ kind: "failed", message: "503" }));

    const item = await itemRow(itemId);
    expect(item?.remindAt?.getTime()).toBe(NOW.getTime() + DAY_MS);
  });

  test("the hold ends: a record still unlisted two months on is published as it stands", async () => {
    const { itemId } = await makeDueItem({ firstReleaseDate: "2019-10-01" });

    await processReminders(NOW, async () => NONE);

    const item = await itemRow(itemId);
    expect(item?.remindAt).toBeNull();
    expect(item?.reminderPending).toBe(true);
  });

  test("an item that already has a link is published without asking anyone", async () => {
    const checkLink = mock(async () => NONE);
    const { itemId } = await makeDueItem({ url: "https://ordinary.bandcamp.com/album/one" });

    await processReminders(NOW, checkLink);

    expect(checkLink).not.toHaveBeenCalled();
    expect((await itemRow(itemId))?.reminderPending).toBe(true);
  });

  test("a reminder the user set on their own item is not the gate's business", async () => {
    const checkLink = mock(async () => NONE);
    const { itemId } = await makeDueItem({ fromAlert: false });

    await processReminders(NOW, checkLink);

    expect(checkLink).not.toHaveBeenCalled();
    const item = await itemRow(itemId);
    expect(item?.remindAt).toBeNull();
    expect(item?.reminderPending).toBe(true);
  });

  test("a reminder that isn't due yet is left alone", async () => {
    const { itemId } = await makeDueItem({ remindAt: new Date(NOW.getTime() + DAY_MS) });

    await processReminders(NOW, async () => FOUND);

    const item = await itemRow(itemId);
    expect(item?.reminderPending).toBe(false);
    expect(item?.remindAt?.getTime()).toBe(NOW.getTime() + DAY_MS);
  });

  test("one held record doesn't stop another from being published", async () => {
    const held = await makeDueItem();
    const passing = await makeDueItem({ url: "https://ordinary.bandcamp.com/album/two" });

    await processReminders(NOW, async (query) =>
      query.title.includes(String(sequence)) ? FOUND : NONE,
    );

    expect((await itemRow(held.itemId))?.reminderPending).toBe(false);
    expect((await itemRow(passing.itemId))?.reminderPending).toBe(true);
  });
});

// Guard against the join fanning out: an item carries at most one alert, but a
// left join that matched two rows would publish it twice and log it twice.
test("an item with several links is still processed once", async () => {
  const { itemId } = await makeDueItem({ url: "https://ordinary.bandcamp.com/album/three" });
  await db.insert(musicLinks).values({ musicItemId: itemId, url: "https://example.test/other" });

  await processReminders(NOW, async () => NONE);

  const rows = await db
    .select()
    .from(musicItems)
    .where(and(eq(musicItems.id, itemId), eq(musicItems.reminderPending, true)));
  expect(rows).toHaveLength(1);
});

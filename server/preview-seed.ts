import { db } from "./db/index";
import { artists, musicItems, musicItemStacks, stacks } from "./db/schema";

/**
 * Demo content for preview deployments. Gated behind PREVIEW_SEED=1 and only
 * ever runs against a database with no music items, so it cannot touch real
 * data. Gives an ephemeral preview enough variety to exercise every surface:
 * all listen statuses, ratings, stacks, and both overdue and upcoming
 * reminders.
 */
export async function seedPreviewData(): Promise<void> {
  const existing = await db.select({ id: musicItems.id }).from(musicItems).limit(1);
  if (existing.length > 0) {
    return;
  }

  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();

  const artistRows = await db
    .insert(artists)
    .values(
      ["Slope Unit", "Coastal Static", "Capybara Sound System", "Night Bus Quartet"].map(
        (name) => ({ name, normalizedName: name.toLowerCase() }),
      ),
    )
    .returning({ id: artists.id });

  const demoItems: Array<{
    title: string;
    artistIdx: number;
    listenStatus: "to-listen" | "listened";
    rating?: number;
    remindAt?: Date;
    genre?: string;
    year?: number;
  }> = [
    {
      title: "Night Bus Tape",
      artistIdx: 0,
      listenStatus: "to-listen",
      genre: "Ambient",
      year: 2024,
    },
    { title: "Water Bearer", artistIdx: 1, listenStatus: "to-listen", genre: "Folk", year: 1978 },
    { title: "Surf Memory", artistIdx: 2, listenStatus: "to-listen", genre: "Dub", year: 2023 },
    { title: "Terminal Departures", artistIdx: 3, listenStatus: "to-listen", year: 2025 },
    { title: "Low Tide Versions", artistIdx: 2, listenStatus: "to-listen", genre: "Dub" },
    { title: "Motorway Sodium", artistIdx: 0, listenStatus: "listened", rating: 8, year: 2022 },
    { title: "Greenhouse Nights", artistIdx: 1, listenStatus: "listened", rating: 6 },
    { title: "Pier Organ Suite", artistIdx: 3, listenStatus: "listened", rating: 9, year: 2021 },
    {
      title: "Causeway",
      artistIdx: 1,
      listenStatus: "to-listen",
      remindAt: new Date(now + 9 * day),
    },
    {
      title: "Static Bloom",
      artistIdx: 0,
      listenStatus: "to-listen",
      remindAt: new Date(now - 2 * day),
    },
  ];

  const itemRows = await db
    .insert(musicItems)
    .values(
      demoItems.map((item) => ({
        title: item.title,
        normalizedTitle: item.title.toLowerCase(),
        listenStatus: item.listenStatus,
        artistId: artistRows[item.artistIdx].id,
        rating: item.rating ?? null,
        remindAt: item.remindAt ?? null,
        genre: item.genre ?? null,
        year: item.year ?? null,
      })),
    )
    .returning({ id: musicItems.id });

  const stackRows = await db
    .insert(stacks)
    .values([{ name: "Ambient" }, { name: "Crate Digs" }, { name: "Road Trip" }])
    .returning({ id: stacks.id });

  await db.insert(musicItemStacks).values([
    { musicItemId: itemRows[0].id, stackId: stackRows[0].id },
    { musicItemId: itemRows[2].id, stackId: stackRows[0].id },
    { musicItemId: itemRows[2].id, stackId: stackRows[1].id },
    { musicItemId: itemRows[4].id, stackId: stackRows[1].id },
    { musicItemId: itemRows[5].id, stackId: stackRows[2].id },
    { musicItemId: itemRows[8].id, stackId: stackRows[2].id },
  ]);

  console.log(`[preview-seed] Seeded ${itemRows.length} demo items, 4 artists, 3 stacks.`);
}

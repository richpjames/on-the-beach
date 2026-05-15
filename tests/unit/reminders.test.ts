import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";

// Attempt to isolate from the dev DB. Earlier test files in the run may already
// have imported `server/db/index` with the default path, in which case this
// assignment is ignored — so every test below also cleans up the rows it inserts.
const TEST_DB = `/tmp/reminders-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
process.env.DATABASE_PATH ??= TEST_DB;
for (const suffix of ["", "-shm", "-wal"]) {
  try {
    fs.rmSync(TEST_DB + suffix, { force: true });
  } catch {
    // ignore
  }
}

const insertedItemIds: number[] = [];

afterEach(async () => {
  if (insertedItemIds.length === 0) return;
  const { db } = await import("../../server/db/index");
  const { musicItems } = await import("../../server/db/schema");
  const { inArray } = await import("drizzle-orm");
  await db.delete(musicItems).where(inArray(musicItems.id, insertedItemIds));
  insertedItemIds.length = 0;
});

describe("processReminders", () => {
  test("is a function", async () => {
    const { processReminders } = await import("../../server/reminders");
    expect(typeof processReminders).toBe("function");
  });

  test("bumps added_to_listen_at to now so the item sorts to the top of to-listen", async () => {
    const { db } = await import("../../server/db/index");
    const { musicItems } = await import("../../server/db/schema");
    const { processReminders } = await import("../../server/reminders");
    const { eq } = await import("drizzle-orm");

    const past = new Date("2020-01-01T00:00:00Z");
    const dueAt = new Date(Date.now() - 60_000);

    const [inserted] = await db
      .insert(musicItems)
      .values({
        title: "Scheduled item",
        normalizedTitle: "scheduled item",
        listenStatus: "to-listen",
        createdAt: past,
        updatedAt: past,
        addedToListenAt: past,
        remindAt: dueAt,
        reminderPending: false,
      })
      .returning({ id: musicItems.id });
    insertedItemIds.push(inserted.id);

    // SQLite stores timestamps at second precision, so widen the window by
    // a second on each side to absorb rounding.
    const before = Date.now() - 1000;
    await processReminders();
    const after = Date.now() + 1000;

    const row = await db
      .select({
        listenStatus: musicItems.listenStatus,
        reminderPending: musicItems.reminderPending,
        addedToListenAt: musicItems.addedToListenAt,
        createdAt: musicItems.createdAt,
      })
      .from(musicItems)
      .where(eq(musicItems.id, inserted.id))
      .get();

    expect(row?.listenStatus).toBe("to-listen");
    expect(row?.reminderPending).toBe(true);

    const bumped = row?.addedToListenAt instanceof Date ? row.addedToListenAt.getTime() : 0;
    expect(bumped).toBeGreaterThanOrEqual(before);
    expect(bumped).toBeLessThanOrEqual(after);

    // created_at must be untouched so RSS pubDate and original creation time stay correct.
    const created = row?.createdAt instanceof Date ? row.createdAt.getTime() : 0;
    expect(created).toBe(past.getTime());
  });

  test("does not touch items whose reminder is not yet due", async () => {
    const { db } = await import("../../server/db/index");
    const { musicItems } = await import("../../server/db/schema");
    const { processReminders } = await import("../../server/reminders");
    const { eq } = await import("drizzle-orm");

    const past = new Date("2020-06-01T00:00:00Z");
    const futureAt = new Date(Date.now() + 60 * 60_000);

    const [inserted] = await db
      .insert(musicItems)
      .values({
        title: "Future scheduled",
        normalizedTitle: "future scheduled",
        listenStatus: "to-listen",
        createdAt: past,
        updatedAt: past,
        addedToListenAt: past,
        remindAt: futureAt,
        reminderPending: false,
      })
      .returning({ id: musicItems.id });
    insertedItemIds.push(inserted.id);

    await processReminders();

    const row = await db
      .select({ addedToListenAt: musicItems.addedToListenAt })
      .from(musicItems)
      .where(eq(musicItems.id, inserted.id))
      .get();

    const bumped = row?.addedToListenAt instanceof Date ? row.addedToListenAt.getTime() : 0;
    expect(bumped).toBe(past.getTime());
  });
});

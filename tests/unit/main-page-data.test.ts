import { describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import { createActor } from "xstate";
import { appMachine } from "../../src/ui/state/app-machine";

// Use a dedicated test database so we don't pollute the dev DB.
// We set this once at module load — the db module reads the env var at first import.
const TEST_DB = `/tmp/main-page-data-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
process.env.DATABASE_PATH = TEST_DB;
for (const suffix of ["", "-shm", "-wal"]) {
  try {
    fs.rmSync(TEST_DB + suffix, { force: true });
  } catch {
    // ignore
  }
}

// `ingest.test.ts` calls `mock.module("../../server/music-item-creator", ...)`
// to stub out helpers like `fullItemSelect`. bun's module mocks are
// process-wide and persist across test files, so any module that imports
// `music-item-creator` after that point gets stubs. The SSR data module
// imports `fullItemSelect` from `server/queries/full-item-select.ts` directly
// to sidestep that mock — we keep the `mock` import to make the dependency
// explicit in case the module organization changes again.
void mock;

describe("main page SSR data: /", () => {
  test("returns only items with to-listen status", async () => {
    const { db } = await import("../../server/db/index");
    const { musicItems } = await import("../../server/db/schema");
    const { fetchInitialItems } = await import("../../server/queries/main-page-data");

    const inserted = await db
      .insert(musicItems)
      .values([
        { title: "ToListenA", normalizedTitle: "tolistena", listenStatus: "to-listen" },
        { title: "ListenedA", normalizedTitle: "listeneda", listenStatus: "listened" },
        { title: "ToListenB", normalizedTitle: "tolistenb", listenStatus: "to-listen" },
        { title: "ListenedB", normalizedTitle: "listenedb", listenStatus: "listened" },
      ])
      .returning({ id: musicItems.id, status: musicItems.listenStatus });

    const expectedToListenIds = inserted.filter((i) => i.status === "to-listen").map((i) => i.id);
    const expectedListenedIds = inserted.filter((i) => i.status === "listened").map((i) => i.id);

    const items = await fetchInitialItems(null);
    const returnedIds = items.map((i) => i.id);

    // Sanity check: all to-listen items returned
    for (const id of expectedToListenIds) {
      expect(returnedIds).toContain(id);
    }

    // Bug check: NO listened items should be returned for the default route
    for (const id of expectedListenedIds) {
      expect(returnedIds).not.toContain(id);
    }
  });

  test("excludes scheduled items (remind_at set) from the to-listen view", async () => {
    const { db } = await import("../../server/db/index");
    const { musicItems } = await import("../../server/db/schema");
    const { fetchInitialItems } = await import("../../server/queries/main-page-data");

    const inserted = await db
      .insert(musicItems)
      .values([
        {
          title: "ScheduledItem",
          normalizedTitle: "scheduleditem",
          listenStatus: "to-listen",
          remindAt: new Date("2030-01-01T00:00:00Z"),
        },
        {
          title: "PlainToListen",
          normalizedTitle: "plaintolisten",
          listenStatus: "to-listen",
        },
      ])
      .returning({ id: musicItems.id, title: musicItems.title });

    const scheduledId = inserted.find((i) => i.title === "ScheduledItem")!.id;
    const plainId = inserted.find((i) => i.title === "PlainToListen")!.id;

    const items = await fetchInitialItems(null);
    const returnedIds = items.map((i) => i.id);

    expect(returnedIds).toContain(plainId);
    expect(returnedIds).not.toContain(scheduledId);
  });

  test("app machine defaults to the to-listen filter without a stack scope", () => {
    const actor = createActor(appMachine, { input: { currentStack: null } }).start();
    expect(actor.getSnapshot().context.currentFilter).toBe("to-listen");
    expect(actor.getSnapshot().context.currentStack).toBeNull();
    actor.stop();
  });
});

describe("main page SSR data: /s/:id/:name", () => {
  test("returns items in the stack regardless of listen status", async () => {
    const { db } = await import("../../server/db/index");
    const { musicItems, stacks, musicItemStacks } = await import("../../server/db/schema");
    const { fetchInitialItems } = await import("../../server/queries/main-page-data");

    const [stack] = await db
      .insert(stacks)
      .values({ name: "TestStack" })
      .returning({ id: stacks.id });

    const inserted = await db
      .insert(musicItems)
      .values([
        {
          title: "InStackToListen",
          normalizedTitle: "instacktolisten",
          listenStatus: "to-listen",
        },
        {
          title: "InStackListened",
          normalizedTitle: "instacklistened",
          listenStatus: "listened",
        },
        {
          title: "OutOfStackToListen",
          normalizedTitle: "outofstacktolisten",
          listenStatus: "to-listen",
        },
      ])
      .returning({ id: musicItems.id, status: musicItems.listenStatus });

    // Add the first two items to the stack; the third stays orphaned
    await db.insert(musicItemStacks).values([
      { musicItemId: inserted[0].id, stackId: stack.id },
      { musicItemId: inserted[1].id, stackId: stack.id },
    ]);

    const items = await fetchInitialItems(stack.id);
    const returnedIds = items.map((i) => i.id);

    // Both stack items must return — including the listened one
    expect(returnedIds).toContain(inserted[0].id);
    expect(returnedIds).toContain(inserted[1].id);
    // The non-stack item must NOT return even though it's to-listen
    expect(returnedIds).not.toContain(inserted[2].id);
  });

  test("app machine forces the 'all' filter when seeded with a stack scope", () => {
    // On stack URLs the UI must show all statuses — the machine seed mirrors
    // what STACK_SELECTED does at runtime.
    const actor = createActor(appMachine, { input: { currentStack: 7 } }).start();
    expect(actor.getSnapshot().context.currentFilter).toBe("all");
    expect(actor.getSnapshot().context.currentStack).toBe(7);
    actor.stop();
  });

  test("fetchInitialStacks includes parent ids and item counts", async () => {
    const { db } = await import("../../server/db/index");
    const { stacks, stackParents } = await import("../../server/db/schema");
    const { fetchInitialStacks } = await import("../../server/queries/main-page-data");

    const [parent] = await db
      .insert(stacks)
      .values({ name: "ParentStack" })
      .returning({ id: stacks.id });
    const [child] = await db
      .insert(stacks)
      .values({ name: "ChildStack" })
      .returning({ id: stacks.id });
    await db.insert(stackParents).values({ parentStackId: parent.id, childStackId: child.id });

    const allStacks = await fetchInitialStacks();
    const childRow = allStacks.find((s) => s.id === child.id);

    expect(childRow).toBeDefined();
    expect(childRow!.parent_stack_ids).toContain(parent.id);
    expect(typeof childRow!.item_count).toBe("number");
  });
});

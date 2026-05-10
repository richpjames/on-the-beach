import { describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";

// Use a dedicated test database so we don't pollute the dev DB.
// We set this once at module load — the db module reads the env var at first import.
const TEST_DB = `/tmp/main-page-ssr-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
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
// `music-item-creator` after that point gets stubs. The SSR (`main-page.ts`)
// now imports `fullItemSelect` from `server/queries/full-item-select.ts`
// directly to sidestep that mock, so this file does not need to re-register
// anything — but we keep the `mock` import to make the dependency explicit
// in case the module organization changes again.
void mock;

describe("SSR /", () => {
  test("renders only items with to-listen status", async () => {
    const { db } = await import("../../server/db/index");
    const { musicItems } = await import("../../server/db/schema");
    const { createMainPageRoutes } = await import("../../server/routes/main-page");

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

    const app = createMainPageRoutes();
    const res = await app.request("http://localhost/");
    const html = await res.text();

    const renderedIds = [
      ...new Set([...html.matchAll(/data-item-id="(\d+)"/g)].map((m) => Number(m[1]))),
    ];

    // Sanity check: all to-listen items rendered
    for (const id of expectedToListenIds) {
      expect(renderedIds).toContain(id);
    }

    // Bug check: NO listened items should be rendered on the default route
    for (const id of expectedListenedIds) {
      expect(renderedIds).not.toContain(id);
    }
  });

  test("filter-bar marks 'To Listen' as the active filter", async () => {
    const { createMainPageRoutes } = await import("../../server/routes/main-page");

    const app = createMainPageRoutes();
    const res = await app.request("http://localhost/");
    const html = await res.text();

    expect(html).toContain('class="filter-btn active" data-filter="to-listen"');
    // No other filter button should be active
    expect(html).not.toContain('class="filter-btn active" data-filter="all"');
    expect(html).not.toContain('class="filter-btn active" data-filter="listened"');
    expect(html).not.toContain('class="filter-btn active" data-filter="scheduled"');
  });
});

describe("SSR /s/:id/:name", () => {
  test("renders items in the stack regardless of listen status", async () => {
    const { db } = await import("../../server/db/index");
    const { musicItems, stacks, musicItemStacks } = await import("../../server/db/schema");
    const { createMainPageRoutes } = await import("../../server/routes/main-page");

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

    const app = createMainPageRoutes();
    const res = await app.request(`http://localhost/s/${stack.id}/teststack`);
    const html = await res.text();

    const renderedIds = [
      ...new Set([...html.matchAll(/data-item-id="(\d+)"/g)].map((m) => Number(m[1]))),
    ];

    // Both stack items must render — including the listened one
    expect(renderedIds).toContain(inserted[0].id);
    expect(renderedIds).toContain(inserted[1].id);
    // The non-stack item must NOT render even though it's to-listen
    expect(renderedIds).not.toContain(inserted[2].id);
  });

  test("filter-bar marks 'All' as the active filter on stack URLs", async () => {
    const { db } = await import("../../server/db/index");
    const { stacks } = await import("../../server/db/schema");
    const { createMainPageRoutes } = await import("../../server/routes/main-page");

    const [stack] = await db
      .insert(stacks)
      .values({ name: "FilterStack" })
      .returning({ id: stacks.id });

    const app = createMainPageRoutes();
    const res = await app.request(`http://localhost/s/${stack.id}/filterstack`);
    const html = await res.text();

    // On stack URLs, JS forces filter to "all" via STACK_SELECTED — the SSR
    // must mirror that or the user sees a filter/items mismatch on first paint.
    expect(html).toContain('class="filter-btn active" data-filter="all"');
    expect(html).not.toContain('class="filter-btn active" data-filter="to-listen"');
  });
});

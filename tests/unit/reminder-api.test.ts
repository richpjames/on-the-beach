import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

// We'll test the reminder endpoints in isolation using a mock db
// The routes file exports musicItemRoutes; we test it via app.request()

// NOTE: these are integration-style tests against the real route handler
// using the test DB (NODE_ENV=test). Run with: bun test tests/unit/reminder-api.test.ts
// For now we write the shape tests.

import { musicItemRoutes } from "../../server/routes/music-items";

function makeApp() {
  const app = new Hono();
  app.route("/api/music-items", musicItemRoutes);
  return app;
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

describe("PUT /api/music-items/:id/reminder", () => {
  test("returns 400 for non-numeric id", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/music-items/abc/reminder", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remindAt: "2026-06-01" }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 when remindAt is missing", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/music-items/1/reminder", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 when remindAt is not a valid date string", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/music-items/1/reminder", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remindAt: "not-a-date" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/music-items/:id/reminder", () => {
  test("returns 400 for non-numeric id", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/music-items/abc/reminder", {
      method: "DELETE",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/music-items/reminders/pending", () => {
  test("returns 200 with items array", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/music-items/reminders/pending");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
  });
});

describe("GET /api/music-items?hasReminder=true", () => {
  test("excludes items whose scheduled date is in the past", async () => {
    const { db } = await import("../../server/db/index");
    const { musicItems } = await import("../../server/db/schema");

    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60 * 60_000);

    const [pastItem] = await db
      .insert(musicItems)
      .values({
        title: "Past scheduled",
        normalizedTitle: "past scheduled",
        listenStatus: "to-listen",
        createdAt: past,
        updatedAt: past,
        addedToListenAt: past,
        remindAt: past,
        reminderPending: false,
      })
      .returning({ id: musicItems.id });
    insertedItemIds.push(pastItem.id);

    const [futureItem] = await db
      .insert(musicItems)
      .values({
        title: "Future scheduled",
        normalizedTitle: "future scheduled",
        listenStatus: "to-listen",
        createdAt: past,
        updatedAt: past,
        addedToListenAt: past,
        remindAt: future,
        reminderPending: false,
      })
      .returning({ id: musicItems.id });
    insertedItemIds.push(futureItem.id);

    const app = makeApp();
    const res = await app.request("http://localhost/api/music-items?hasReminder=true");
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = (body.items as Array<{ id: number }>).map((i) => i.id);
    expect(ids).toContain(futureItem.id);
    expect(ids).not.toContain(pastItem.id);
  });
});

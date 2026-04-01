import { beforeEach, describe, expect, mock, test } from "bun:test";
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

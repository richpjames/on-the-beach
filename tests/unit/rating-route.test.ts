import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { musicItemRoutes } from "../../server/routes/music-items";
import { createMusicItemDirect } from "../../app/music-item-store";
import { db } from "../../adapters/db/index";
import { musicItems } from "../../adapters/db/schema";

// Ratings cross the PATCH boundary as the stored out-of-100 value — these
// tests pin the validation at the route (see domain/rating.ts for the scale).

process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/music-items", musicItemRoutes);
  return app;
}

async function storedRating(id: number): Promise<number | null> {
  const [row] = await db
    .select({ rating: musicItems.rating })
    .from(musicItems)
    .where(eq(musicItems.id, id))
    .limit(1);
  return row?.rating ?? null;
}

describe("PATCH /api/music-items/:id rating", () => {
  test("stores an out-of-100 rating and clears with null", async () => {
    const { item } = await createMusicItemDirect({ title: "Rating Route" });

    const set = await makeApp().request(`http://localhost/api/music-items/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating: 87.5 }),
    });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { item: { rating: number } }).item.rating).toBe(87.5);
    expect(await storedRating(item.id)).toBe(87.5);

    const clear = await makeApp().request(`http://localhost/api/music-items/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating: null }),
    });
    expect(clear.status).toBe(200);
    expect(await storedRating(item.id)).toBeNull();
  });

  test("rounds over-precise values to the two decimals the scale keeps", async () => {
    const { item } = await createMusicItemDirect({ title: "Rounding Route" });

    const res = await makeApp().request(`http://localhost/api/music-items/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating: 66.666666 }),
    });

    expect(res.status).toBe(200);
    expect(await storedRating(item.id)).toBe(66.67);
  });

  test("rejects ratings outside 0–100 rather than coercing them", async () => {
    const { item } = await createMusicItemDirect({ title: "Rejecting Route" });

    // Infinity can't be in this list: JSON.stringify turns it into null,
    // which is the legitimate "clear the rating" payload.
    for (const rating of [101, -1, "90"]) {
      const res = await makeApp().request(`http://localhost/api/music-items/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating }),
      });
      expect(res.status).toBe(400);
      expect(await storedRating(item.id)).toBeNull();
    }
  });
});

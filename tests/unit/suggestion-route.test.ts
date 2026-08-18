import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../../server/db/index";
import { artists, itemSuggestions, musicItems } from "../../server/db/schema";
import { musicItemRoutes } from "../../server/routes/music-items";
import { normalize } from "../../server/utils";

// The prompt offers up to three releases, so the accept/dismiss endpoints have
// to be told which one the user picked — "the artist's pending suggestion" is
// no longer a single row.

const ARTIST = "Suggestion Route Band";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/music-items", musicItemRoutes);
  return app;
}

let sourceItemId: number;

async function seedSuggestions(titles: string[]): Promise<number[]> {
  const rows = await db
    .insert(itemSuggestions)
    .values(
      titles.map((title) => ({
        sourceItemId,
        title,
        artistName: ARTIST,
        itemType: "album",
        status: "pending",
      })),
    )
    .returning({ id: itemSuggestions.id });
  return rows.map((row) => row.id);
}

function post(path: string, body?: unknown) {
  return makeApp().request(`http://localhost/api/music-items/${sourceItemId}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function statusOf(suggestionId: number): Promise<string | undefined> {
  const row = await db
    .select({ status: itemSuggestions.status })
    .from(itemSuggestions)
    .where(eq(itemSuggestions.id, suggestionId))
    .get();
  return row?.status;
}

beforeEach(async () => {
  process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";
  const [artist] = await db
    .insert(artists)
    .values({ name: ARTIST, normalizedName: normalize(ARTIST) })
    .onConflictDoNothing()
    .returning({ id: artists.id });
  const artistId =
    artist?.id ??
    (await db
      .select({ id: artists.id })
      .from(artists)
      .where(eq(artists.normalizedName, normalize(ARTIST)))
      .get())!.id;

  const [item] = await db
    .insert(musicItems)
    .values({ title: "Source Album", normalizedTitle: normalize("Source Album"), artistId })
    .returning({ id: musicItems.id });
  sourceItemId = item.id;
});

afterEach(async () => {
  await db.delete(itemSuggestions).where(eq(itemSuggestions.sourceItemId, sourceItemId));
  // Accepting creates a release of its own — clear the whole artist so the
  // next case starts from an empty library.
  const artist = await db
    .select({ id: artists.id })
    .from(artists)
    .where(eq(artists.normalizedName, normalize(ARTIST)))
    .get();
  if (artist) await db.delete(musicItems).where(eq(musicItems.artistId, artist.id));
  await db.delete(musicItems).where(eq(musicItems.id, sourceItemId));
  delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
});

describe("POST /:id/suggestion/accept", () => {
  test("adds the suggestion the user picked, not the first one offered", async () => {
    const [, second] = await seedSuggestions(["First Offer", "Second Offer", "Third Offer"]);

    const response = await post("/suggestion/accept", { suggestionId: second });

    expect(response.status).toBe(201);
    const created = (await response.json()) as { title: string };
    expect(created.title).toBe("Second Offer");
    expect(await statusOf(second)).toBe("accepted");
  });

  test("leaves the releases the user did not pick pending for next time", async () => {
    const [first, second, third] = await seedSuggestions([
      "First Offer",
      "Second Offer",
      "Third Offer",
    ]);

    await post("/suggestion/accept", { suggestionId: second });

    expect(await statusOf(first)).toBe("pending");
    expect(await statusOf(third)).toBe("pending");
  });

  test("falls back to the first suggestion when no id is sent", async () => {
    const [first] = await seedSuggestions(["First Offer", "Second Offer"]);

    const response = await post("/suggestion/accept");

    expect(response.status).toBe(201);
    expect(await statusOf(first)).toBe("accepted");
  });

  test("404s on an id that is not one of the item's pending suggestions", async () => {
    await seedSuggestions(["First Offer"]);

    const response = await post("/suggestion/accept", { suggestionId: -1 });

    expect(response.status).toBe(404);
  });
});

describe("POST /:id/suggestion/dismiss", () => {
  test("dismisses every release the prompt offered", async () => {
    const ids = await seedSuggestions(["First Offer", "Second Offer", "Third Offer"]);

    const response = await post("/suggestion/dismiss", { suggestionIds: ids });

    expect(response.status).toBe(200);
    for (const id of ids) {
      expect(await statusOf(id)).toBe("dismissed");
    }
  });

  test("dismisses only the first when the client sends no ids", async () => {
    const [first, second] = await seedSuggestions(["First Offer", "Second Offer"]);

    await post("/suggestion/dismiss");

    expect(await statusOf(first)).toBe("dismissed");
    expect(await statusOf(second)).toBe("pending");
  });
});

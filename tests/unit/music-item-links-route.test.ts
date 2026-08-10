import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../../server/db/index";
import { musicItems, musicLinks } from "../../server/db/schema";
import { musicItemRoutes } from "../../server/routes/music-items";

// A link added by hand on the release page never went through the scrape that
// creating a release from a URL performs, so the route has to do it itself.
// Without the player ids it collects, the release page holds a Bandcamp URL it
// can't build a player from.

const BANDCAMP_URL = "https://seekersinternational.bandcamp.com/album/where-between-you-me";

const BANDCAMP_HTML = `<html><head>
<meta property="og:title" content="Where Between You &amp; Me, by Seekersinternational">
<meta name="bc-page-properties" content='{"item_type":"album","item_id":998877}'>
</head><body></body></html>`;

const insertedItemIds: number[] = [];
const realFetch = globalThis.fetch;
let fetchCalls = 0;

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/music-items", musicItemRoutes);
  return app;
}

async function insertItem(): Promise<number> {
  const [inserted] = await db
    .insert(musicItems)
    .values({
      title: "Where Between You & Me",
      normalizedTitle: "where between you & me",
      listenStatus: "to-listen",
    })
    .returning({ id: musicItems.id });

  insertedItemIds.push(inserted.id);
  return inserted.id;
}

function addLink(id: number, body: Record<string, unknown>) {
  return makeApp().request(`http://localhost/api/music-items/${id}/links`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readLinks(id: number) {
  return db
    .select({
      url: musicLinks.url,
      isPrimary: musicLinks.isPrimary,
      metadata: musicLinks.metadata,
    })
    .from(musicLinks)
    .where(eq(musicLinks.musicItemId, id));
}

beforeEach(() => {
  fetchCalls = 0;
  // Stand in for the release page itself — the scraper streams the response
  // body, so a real Response keeps that path intact without going online.
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response(BANDCAMP_HTML, { headers: { "content-type": "text/html" } });
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (insertedItemIds.length === 0) return;
  await db.delete(musicItems).where(inArray(musicItems.id, insertedItemIds));
  insertedItemIds.length = 0;
});

describe("POST /api/music-items/:id/links", () => {
  test("stores the Bandcamp player ids alongside a hand-added link", async () => {
    const id = await insertItem();

    const res = await addLink(id, { sourceName: "Bandcamp", url: BANDCAMP_URL });

    expect(res.status).toBe(201);
    const [link] = await readLinks(id);
    expect(link.url).toBe(BANDCAMP_URL);
    expect(JSON.parse(link.metadata!)).toEqual({ album_id: "998877", item_type: "album" });
  });

  test("makes the first link on a release its primary one", async () => {
    const id = await insertItem();

    await addLink(id, { sourceName: "Bandcamp", url: BANDCAMP_URL });

    const [link] = await readLinks(id);
    expect(link.isPrimary).toBe(true);
  });

  test("stores no metadata, and scrapes nothing, for a source with no player ids", async () => {
    const id = await insertItem();

    const res = await addLink(id, {
      sourceName: "Spotify",
      url: "https://open.spotify.com/album/1A2B3C4D5E",
    });

    expect(res.status).toBe(201);
    const [link] = await readLinks(id);
    expect(link.metadata).toBeNull();
    expect(fetchCalls).toBe(0);
  });

  test("rejects a second copy of a link the release already has", async () => {
    const id = await insertItem();
    await addLink(id, { sourceName: "Bandcamp", url: BANDCAMP_URL });

    const res = await addLink(id, { sourceName: "Bandcamp", url: BANDCAMP_URL });

    expect(res.status).toBe(409);
    expect(await readLinks(id)).toHaveLength(1);
  });
});

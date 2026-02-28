import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { createRssRoutes } from "../../server/routes/rss";
import type { MusicItemFull } from "../../src/types";

type StackInfo = { id: number; name: string };

function makeItem(overrides: Partial<MusicItemFull> = {}): MusicItemFull {
  return {
    id: 1,
    title: "Music Has the Right to Children",
    normalized_title: "music has the right to children",
    item_type: "album",
    artist_id: 1,
    artist_name: "Boards of Canada",
    listen_status: "to-listen",
    purchase_intent: "maybe",
    price_cents: null,
    currency: "GBP",
    notes: null,
    rating: null,
    created_at: "2024-01-15T10:00:00.000Z",
    updated_at: "2024-01-15T10:00:00.000Z",
    listened_at: null,
    artwork_url: null,
    is_physical: 0,
    physical_format: null,
    label: null,
    year: 1998,
    country: null,
    genre: null,
    catalogue_number: null,
    primary_url: "https://music.example.com/boards-of-canada",
    primary_source: "bandcamp",
    stacks: [],
    ...overrides,
  };
}

function makeApp(
  fetchStack: (stackId: number) => Promise<StackInfo | null>,
  fetchStackItems: (stackId: number) => Promise<MusicItemFull[]>,
): Hono {
  const app = new Hono();
  app.route("/feed", createRssRoutes(fetchStack, fetchStackItems));
  return app;
}

describe("GET /feed/stacks/:stackId.rss", () => {
  test("returns 404 when stack does not exist", async () => {
    const fetchStack = mock(async (_id: number) => null);
    const fetchItems = mock(async (_id: number) => []);
    const app = makeApp(fetchStack, fetchItems);

    const res = await app.request("http://localhost/feed/stacks/99.rss");

    expect(res.status).toBe(404);
    expect(fetchItems).not.toHaveBeenCalled();
  });

  test("returns 400 for a non-numeric stack ID", async () => {
    const fetchStack = mock(async (_id: number) => null);
    const fetchItems = mock(async (_id: number) => []);
    const app = makeApp(fetchStack, fetchItems);

    const res = await app.request("http://localhost/feed/stacks/abc.rss");

    expect(res.status).toBe(400);
    expect(fetchStack).not.toHaveBeenCalled();
  });

  test("returns 200 with RSS content type when stack exists", async () => {
    const fetchStack = mock(async (_id: number) => ({ id: 1, name: "Ambient" }));
    const fetchItems = mock(async (_id: number) => []);
    const app = makeApp(fetchStack, fetchItems);

    const res = await app.request("http://localhost/feed/stacks/1.rss");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/rss+xml");
  });

  test("feed title is the stack name", async () => {
    const fetchStack = mock(async (_id: number) => ({ id: 5, name: "Jazz" }));
    const fetchItems = mock(async (_id: number) => []);
    const app = makeApp(fetchStack, fetchItems);

    const res = await app.request("http://localhost/feed/stacks/5.rss");
    const body = await res.text();

    expect(body).toContain("<title>Jazz</title>");
  });

  test("returns valid RSS envelope", async () => {
    const fetchStack = mock(async (_id: number) => ({ id: 1, name: "Ambient" }));
    const fetchItems = mock(async (_id: number) => []);
    const app = makeApp(fetchStack, fetchItems);

    const res = await app.request("http://localhost/feed/stacks/1.rss");
    const body = await res.text();

    expect(body).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(body).toContain("<rss");
    expect(body).toContain("<channel>");
    expect(body).toContain("</channel>");
    expect(body).toContain("</rss>");
  });

  test("includes an RSS item for each stack entry", async () => {
    const fetchStack = mock(async (_id: number) => ({ id: 1, name: "Ambient" }));
    const items = [
      makeItem({ id: 1, title: "Selected Ambient Works", artist_name: "Aphex Twin" }),
      makeItem({ id: 2, title: "Ambient 1: Music for Airports", artist_name: "Brian Eno" }),
    ];
    const fetchItems = mock(async (_id: number) => items);
    const app = makeApp(fetchStack, fetchItems);

    const res = await app.request("http://localhost/feed/stacks/1.rss");
    const body = await res.text();

    expect(body).toContain("Selected Ambient Works");
    expect(body).toContain("Aphex Twin");
    expect(body).toContain("Ambient 1: Music for Airports");
    expect(body).toContain("Brian Eno");
  });

  test("item title combines artist and album name", async () => {
    const fetchStack = mock(async (_id: number) => ({ id: 1, name: "Ambient" }));
    const fetchItems = mock(async (_id: number) => [
      makeItem({ title: "Geogaddi", artist_name: "Boards of Canada" }),
    ]);
    const app = makeApp(fetchStack, fetchItems);

    const res = await app.request("http://localhost/feed/stacks/1.rss");
    const body = await res.text();

    expect(body).toContain("<title>Boards of Canada — Geogaddi</title>");
  });

  test("item title uses only album name when artist is unknown", async () => {
    const fetchStack = mock(async (_id: number) => ({ id: 1, name: "Ambient" }));
    const fetchItems = mock(async (_id: number) => [
      makeItem({ title: "Untitled Mix", artist_name: null }),
    ]);
    const app = makeApp(fetchStack, fetchItems);

    const res = await app.request("http://localhost/feed/stacks/1.rss");
    const body = await res.text();

    expect(body).toContain("<title>Untitled Mix</title>");
  });

  test("item link uses primary_url", async () => {
    const fetchStack = mock(async (_id: number) => ({ id: 1, name: "Ambient" }));
    const fetchItems = mock(async (_id: number) => [
      makeItem({ primary_url: "https://bandcamp.com/album/geogaddi" }),
    ]);
    const app = makeApp(fetchStack, fetchItems);

    const res = await app.request("http://localhost/feed/stacks/1.rss");
    const body = await res.text();

    expect(body).toContain("<link>https://bandcamp.com/album/geogaddi</link>");
  });

  test("item pubDate is derived from created_at", async () => {
    const fetchStack = mock(async (_id: number) => ({ id: 1, name: "Ambient" }));
    const fetchItems = mock(async (_id: number) => [
      makeItem({ created_at: "2024-01-15T10:00:00.000Z" }),
    ]);
    const app = makeApp(fetchStack, fetchItems);

    const res = await app.request("http://localhost/feed/stacks/1.rss");
    const body = await res.text();

    expect(body).toContain("<pubDate>Mon, 15 Jan 2024");
  });

  test("empty stack returns a feed with no items", async () => {
    const fetchStack = mock(async (_id: number) => ({ id: 1, name: "Ambient" }));
    const fetchItems = mock(async (_id: number) => []);
    const app = makeApp(fetchStack, fetchItems);

    const res = await app.request("http://localhost/feed/stacks/1.rss");
    const body = await res.text();

    expect(body).not.toContain("<item>");
    expect(body).toContain("<channel>");
  });

  test("passes the correct stack ID to both fetch functions", async () => {
    const fetchStack = mock(async (id: number) => ({ id, name: "Electronic" }));
    const fetchItems = mock(async (_id: number) => []);
    const app = makeApp(fetchStack, fetchItems);

    await app.request("http://localhost/feed/stacks/7.rss");

    expect(fetchStack).toHaveBeenCalledWith(7);
    expect(fetchItems).toHaveBeenCalledWith(7);
  });
});

import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { createRssRoutes } from "../../server/routes/rss";
import type { MusicItemFull } from "../../domain/types";
import type { PrimaryFeedKey } from "../../domain/rss";
import type { ReleaseAlertView } from "../../server/release-alerts";

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
    primary_link_metadata: null,
    stacks: [],
    ...overrides,
  };
}

function makeAlert(overrides: Partial<ReleaseAlertView> = {}): ReleaseAlertView {
  return {
    id: 1,
    status: "pending",
    reason: "announced",
    created_at: "2026-07-31T09:00:00.000Z",
    resolved_at: null,
    music_item_id: null,
    artist_id: 1,
    artist_name: "Neil Young",
    musicbrainz_artist_id: "mb-artist",
    release_id: 1,
    mb_release_group_id: "mb-release-group",
    title: "On the Beach",
    primary_type: "Album",
    secondary_types: [],
    first_release_date: "2026-09-18",
    first_release_year: 2026,
    ...overrides,
  };
}

function makeApp(
  fetchStack: (stackId: number) => Promise<StackInfo | null>,
  fetchStackItems: (stackId: number) => Promise<MusicItemFull[]>,
  fetchPrimaryFeedItems: (feed: PrimaryFeedKey) => Promise<MusicItemFull[]>,
  fetchReleaseAlerts: () => Promise<ReleaseAlertView[]> = async () => [],
): Hono {
  const app = new Hono();
  app.route(
    "/feed",
    createRssRoutes(fetchStack, fetchStackItems, fetchPrimaryFeedItems, fetchReleaseAlerts),
  );
  return app;
}

describe("GET /feed/:filter.rss", () => {
  test("returns 200 with RSS content type for the all feed", async () => {
    const fetchStack = mock(async (_id: number) => null);
    const fetchStackItems = mock(async (_id: number) => []);
    const fetchPrimaryFeedItems = mock(async (_feed: PrimaryFeedKey) => []);
    const app = makeApp(fetchStack, fetchStackItems, fetchPrimaryFeedItems);

    const res = await app.request("http://localhost/feed/all.rss");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/rss+xml");
    expect(fetchPrimaryFeedItems).toHaveBeenCalledWith("all");
  });

  test("renders the to-listen feed title", async () => {
    const fetchStack = mock(async (_id: number) => null);
    const fetchStackItems = mock(async (_id: number) => []);
    const fetchPrimaryFeedItems = mock(async (_feed: PrimaryFeedKey) => []);
    const app = makeApp(fetchStack, fetchStackItems, fetchPrimaryFeedItems);

    const res = await app.request("http://localhost/feed/to-listen.rss");
    const body = await res.text();

    expect(body).toContain("<title>On the Beach — To Listen</title>");
    expect(fetchPrimaryFeedItems).toHaveBeenCalledWith("to-listen");
  });

  test("renders the listened feed title", async () => {
    const fetchStack = mock(async (_id: number) => null);
    const fetchStackItems = mock(async (_id: number) => []);
    const fetchPrimaryFeedItems = mock(async (_feed: PrimaryFeedKey) => []);
    const app = makeApp(fetchStack, fetchStackItems, fetchPrimaryFeedItems);

    const res = await app.request("http://localhost/feed/listened.rss");
    const body = await res.text();

    expect(body).toContain("<title>On the Beach — Listened</title>");
    expect(fetchPrimaryFeedItems).toHaveBeenCalledWith("listened");
  });

  test("includes RSS items in the all feed", async () => {
    const fetchStack = mock(async (_id: number) => null);
    const fetchStackItems = mock(async (_id: number) => []);
    const fetchPrimaryFeedItems = mock(async (_feed: PrimaryFeedKey) => [
      makeItem({ title: "Rounds", artist_name: "Four Tet" }),
    ]);
    const app = makeApp(fetchStack, fetchStackItems, fetchPrimaryFeedItems);

    const res = await app.request("http://localhost/feed/all.rss");
    const body = await res.text();

    expect(body).toContain("<title>Four Tet — Rounds</title>");
  });
});

describe("release artwork", () => {
  const noStacks = mock(async (_id: number) => null);
  const noItems = mock(async (_id: number) => []);

  async function allFeedBodyFor(item: MusicItemFull): Promise<string> {
    const app = makeApp(
      noStacks,
      noItems,
      mock(async (_feed: PrimaryFeedKey) => [item]),
    );
    return await (await app.request("http://localhost/feed/all.rss")).text();
  }

  test("external artwork is offered as media content, thumbnail and inline image", async () => {
    const body = await allFeedBodyFor(
      makeItem({ artwork_url: "https://cdn.example.com/covers/rounds.jpg" }),
    );

    expect(body).toContain(
      '<media:content url="https://cdn.example.com/covers/rounds.jpg" medium="image" type="image/jpeg" />',
    );
    expect(body).toContain('<media:thumbnail url="https://cdn.example.com/covers/rounds.jpg" />');
    expect(body).toContain('<img src="https://cdn.example.com/covers/rounds.jpg"');
  });

  test("the media namespace is declared on the feed", async () => {
    const body = await allFeedBodyFor(makeItem({ artwork_url: "https://cdn.example.com/a.jpg" }));

    expect(body).toContain('xmlns:media="http://search.yahoo.com/mrss/"');
  });

  test("uploaded artwork is resolved against the request origin", async () => {
    // A reader fetches images from wherever it runs, so `/uploads/…` has to
    // become an absolute URL or it resolves against the reader, not the app.
    const body = await allFeedBodyFor(makeItem({ artwork_url: "/uploads/cover.png" }));

    expect(body).toContain('<media:content url="http://localhost/uploads/cover.png"');
    expect(body).toContain('type="image/png"');
    expect(body).toContain('<img src="http://localhost/uploads/cover.png"');
  });

  test("artwork carries the item title as alt text", async () => {
    const body = await allFeedBodyFor(
      makeItem({
        title: "Rounds",
        artist_name: "Four Tet",
        artwork_url: "https://cdn.example.com/a.jpg",
      }),
    );

    expect(body).toContain('alt="Four Tet — Rounds"');
  });

  test("an item without artwork gets no image markup", async () => {
    const body = await allFeedBodyFor(makeItem({ artwork_url: null }));

    expect(body).not.toContain("<media:content");
    expect(body).not.toContain("<media:thumbnail");
    expect(body).not.toContain("<img");
  });

  test("artwork that is not an http(s) URL is skipped", async () => {
    const body = await allFeedBodyFor(makeItem({ artwork_url: "data:image/png;base64,iVBORw0KG" }));

    expect(body).not.toContain("<media:content");
    expect(body).not.toContain("<img");
  });

  test("description text is escaped for the HTML readers render it as", async () => {
    const body = await allFeedBodyFor(
      makeItem({ artwork_url: null, notes: "Simon & Garfunkel <b>bootleg</b>" }),
    );

    expect(body).toContain("Simon &amp; Garfunkel &lt;b&gt;bootleg&lt;/b&gt;");
  });

  test("notes cannot close the description's CDATA section early", async () => {
    const body = await allFeedBodyFor(makeItem({ artwork_url: null, notes: "sneaky ]]> text" }));

    expect(body).toContain("sneaky ]]&gt; text");
    expect(body).not.toContain("]]></description>]]>");
  });
});

describe("GET /feed/new-releases.rss", () => {
  const noStacks = mock(async (_id: number) => null);
  const noItems = mock(async (_id: number) => []);
  const noFeedItems = mock(async (_feed: PrimaryFeedKey) => []);

  test("renders one entry per alert, artist and title combined", async () => {
    const app = makeApp(noStacks, noItems, noFeedItems, async () => [
      makeAlert({ artist_name: "Four Tet", title: "Three" }),
    ]);

    const res = await app.request("http://localhost/feed/new-releases.rss");
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/rss+xml");
    expect(body).toContain("<title>On the Beach — New Releases</title>");
    expect(body).toContain("<title>Four Tet — Three</title>");
  });

  test("guid is stable per alert", async () => {
    const app = makeApp(noStacks, noItems, noFeedItems, async () => [makeAlert({ id: 42 })]);

    const body = await (await app.request("http://localhost/feed/new-releases.rss")).text();

    expect(body).toContain('<guid isPermaLink="false">release-alert-42</guid>');
  });

  test("pubDate is when the alert fired, not when the record came out", async () => {
    // A 1978 record surfacing today is news today, and belongs at the top of
    // the reader rather than buried in 1978.
    const app = makeApp(noStacks, noItems, noFeedItems, async () => [
      makeAlert({
        created_at: "2026-07-31T09:00:00.000Z",
        first_release_date: "1978-04-01",
        reason: "catalogue-addition",
      }),
    ]);

    const body = await (await app.request("http://localhost/feed/new-releases.rss")).text();

    expect(body).toContain("<pubDate>Fri, 31 Jul 2026");
    expect(body).not.toContain("<pubDate>Sat, 01 Apr 1978");
  });

  test("the description says why the alert fired", async () => {
    const app = makeApp(noStacks, noItems, noFeedItems, async () => [
      makeAlert({ reason: "announced", first_release_date: "2026-09-18" }),
    ]);

    const body = await (await app.request("http://localhost/feed/new-releases.rss")).text();

    expect(body).toContain("Announced release");
    expect(body).toContain("Album · 2026-09-18");
    expect(body).toContain("https://musicbrainz.org/release-group/mb-release-group");
  });

  test("an empty queue is still a valid feed", async () => {
    const app = makeApp(noStacks, noItems, noFeedItems, async () => []);

    const body = await (await app.request("http://localhost/feed/new-releases.rss")).text();

    expect(body).not.toContain("<item>");
    expect(body).toContain("</rss>");
  });
});

describe("GET /feed/stacks/:stackId.rss", () => {
  test("returns 404 when stack does not exist", async () => {
    const fetchStack = mock(async (_id: number) => null);
    const fetchItems = mock(async (_id: number) => []);
    const fetchPrimaryFeedItems = mock(async (_feed: PrimaryFeedKey) => []);
    const app = makeApp(fetchStack, fetchItems, fetchPrimaryFeedItems);

    const res = await app.request("http://localhost/feed/stacks/99.rss");

    expect(res.status).toBe(404);
    expect(fetchItems).not.toHaveBeenCalled();
  });

  test("returns 400 for a non-numeric stack ID", async () => {
    const fetchStack = mock(async (_id: number) => null);
    const fetchItems = mock(async (_id: number) => []);
    const fetchPrimaryFeedItems = mock(async (_feed: PrimaryFeedKey) => []);
    const app = makeApp(fetchStack, fetchItems, fetchPrimaryFeedItems);

    const res = await app.request("http://localhost/feed/stacks/abc.rss");

    expect(res.status).toBe(400);
    expect(fetchStack).not.toHaveBeenCalled();
  });

  test("returns 200 with RSS content type when stack exists", async () => {
    const fetchStack = mock(async (_id: number) => ({ id: 1, name: "Ambient" }));
    const fetchItems = mock(async (_id: number) => []);
    const fetchPrimaryFeedItems = mock(async (_feed: PrimaryFeedKey) => []);
    const app = makeApp(fetchStack, fetchItems, fetchPrimaryFeedItems);

    const res = await app.request("http://localhost/feed/stacks/1.rss");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/rss+xml");
  });

  test("feed title is the stack name", async () => {
    const fetchStack = mock(async (_id: number) => ({ id: 5, name: "Jazz" }));
    const fetchItems = mock(async (_id: number) => []);
    const fetchPrimaryFeedItems = mock(async (_feed: PrimaryFeedKey) => []);
    const app = makeApp(fetchStack, fetchItems, fetchPrimaryFeedItems);

    const res = await app.request("http://localhost/feed/stacks/5.rss");
    const body = await res.text();

    expect(body).toContain("<title>On the Beach — Jazz</title>");
  });

  test("returns valid RSS envelope", async () => {
    const fetchStack = mock(async (_id: number) => ({ id: 1, name: "Ambient" }));
    const fetchItems = mock(async (_id: number) => []);
    const fetchPrimaryFeedItems = mock(async (_feed: PrimaryFeedKey) => []);
    const app = makeApp(fetchStack, fetchItems, fetchPrimaryFeedItems);

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
    const fetchPrimaryFeedItems = mock(async (_feed: PrimaryFeedKey) => []);
    const app = makeApp(fetchStack, fetchItems, fetchPrimaryFeedItems);

    const res = await app.request("http://localhost/feed/stacks/1.rss");
    const body = await res.text();

    expect(body).toContain("Selected Ambient Works");
    expect(body).toContain("Aphex Twin");
    expect(body).toContain("Ambient 1: Music for Airports");
    expect(body).toContain("Brian Eno");
  });

  test("item title combines artist and release name", async () => {
    const fetchStack = mock(async (_id: number) => ({ id: 1, name: "Ambient" }));
    const fetchItems = mock(async (_id: number) => [
      makeItem({ title: "Geogaddi", artist_name: "Boards of Canada" }),
    ]);
    const fetchPrimaryFeedItems = mock(async (_feed: PrimaryFeedKey) => []);
    const app = makeApp(fetchStack, fetchItems, fetchPrimaryFeedItems);

    const res = await app.request("http://localhost/feed/stacks/1.rss");
    const body = await res.text();

    expect(body).toContain("<title>Boards of Canada — Geogaddi</title>");
  });

  test("item title uses only release name when artist is unknown", async () => {
    const fetchStack = mock(async (_id: number) => ({ id: 1, name: "Ambient" }));
    const fetchItems = mock(async (_id: number) => [
      makeItem({ title: "Untitled Mix", artist_name: null }),
    ]);
    const fetchPrimaryFeedItems = mock(async (_feed: PrimaryFeedKey) => []);
    const app = makeApp(fetchStack, fetchItems, fetchPrimaryFeedItems);

    const res = await app.request("http://localhost/feed/stacks/1.rss");
    const body = await res.text();

    expect(body).toContain("<title>Untitled Mix</title>");
  });

  test("item link points to the internal release page", async () => {
    const fetchStack = mock(async (_id: number) => ({ id: 1, name: "Ambient" }));
    const fetchItems = mock(async (_id: number) => [
      makeItem({ id: 42, primary_url: "https://bandcamp.com/album/geogaddi" }),
    ]);
    const fetchPrimaryFeedItems = mock(async (_feed: PrimaryFeedKey) => []);
    const app = makeApp(fetchStack, fetchItems, fetchPrimaryFeedItems);

    const res = await app.request("http://localhost/feed/stacks/1.rss");
    const body = await res.text();

    expect(body).toContain("<link>http://localhost/r/42</link>");
  });

  test("item pubDate is derived from created_at", async () => {
    const fetchStack = mock(async (_id: number) => ({ id: 1, name: "Ambient" }));
    const fetchItems = mock(async (_id: number) => [
      makeItem({ created_at: "2024-01-15T10:00:00.000Z" }),
    ]);
    const fetchPrimaryFeedItems = mock(async (_feed: PrimaryFeedKey) => []);
    const app = makeApp(fetchStack, fetchItems, fetchPrimaryFeedItems);

    const res = await app.request("http://localhost/feed/stacks/1.rss");
    const body = await res.text();

    expect(body).toContain("<pubDate>Mon, 15 Jan 2024");
  });

  test("empty stack returns a feed with no items", async () => {
    const fetchStack = mock(async (_id: number) => ({ id: 1, name: "Ambient" }));
    const fetchItems = mock(async (_id: number) => []);
    const fetchPrimaryFeedItems = mock(async (_feed: PrimaryFeedKey) => []);
    const app = makeApp(fetchStack, fetchItems, fetchPrimaryFeedItems);

    const res = await app.request("http://localhost/feed/stacks/1.rss");
    const body = await res.text();

    expect(body).not.toContain("<item>");
    expect(body).toContain("<channel>");
  });

  test("item description includes genre, year, source and notes when available", async () => {
    const fetchStack = mock(async (_id: number) => ({ id: 1, name: "Ambient" }));
    const fetchItems = mock(async (_id: number) => [
      makeItem({
        item_type: "album",
        year: 1995,
        genre: "Electronic",
        country: "UK",
        label: "Warp Records",
        catalogue_number: "WARPCD30",
        primary_source: "bandcamp",
        primary_url: "https://warp.bandcamp.com/album/tri-repetae",
        notes: "Seminal album",
        rating: 4,
      }),
    ]);
    const fetchPrimaryFeedItems = mock(async (_feed: PrimaryFeedKey) => []);
    const app = makeApp(fetchStack, fetchItems, fetchPrimaryFeedItems);

    const res = await app.request("http://localhost/feed/stacks/1.rss");
    const body = await res.text();

    expect(body).toContain("Album · 1995 · Electronic · UK");
    expect(body).toContain("Warp Records · WARPCD30");
    expect(body).toContain("Source: Bandcamp");
    expect(body).toContain("★★★★☆");
    expect(body).toContain("Seminal album");
  });

  test("item description omits missing fields gracefully", async () => {
    const fetchStack = mock(async (_id: number) => ({ id: 1, name: "Ambient" }));
    const fetchItems = mock(async (_id: number) => [
      makeItem({ genre: null, year: null, label: null, notes: null, rating: null }),
    ]);
    const fetchPrimaryFeedItems = mock(async (_feed: PrimaryFeedKey) => []);
    const app = makeApp(fetchStack, fetchItems, fetchPrimaryFeedItems);

    const res = await app.request("http://localhost/feed/stacks/1.rss");
    const body = await res.text();

    expect(body).toContain("<description>");
    expect(body).not.toContain("Notes:");
    expect(body).not.toContain("Rating:");
  });

  test("passes the correct stack ID to both fetch functions", async () => {
    const fetchStack = mock(async (id: number) => ({ id, name: "Electronic" }));
    const fetchItems = mock(async (_id: number) => []);
    const fetchPrimaryFeedItems = mock(async (_feed: PrimaryFeedKey) => []);
    const app = makeApp(fetchStack, fetchItems, fetchPrimaryFeedItems);

    await app.request("http://localhost/feed/stacks/7.rss");

    expect(fetchStack).toHaveBeenCalledWith(7);
    expect(fetchItems).toHaveBeenCalledWith(7);
  });
});

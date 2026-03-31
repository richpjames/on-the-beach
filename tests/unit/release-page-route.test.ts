// tests/unit/release-page-route.test.ts
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { createReleasePageRoutes } from "../../server/routes/release-page";

const mockFetchItem = mock();

function makeApp(): Hono {
  const app = new Hono();
  app.route("/r", createReleasePageRoutes(mockFetchItem));
  return app;
}

const baseItem = {
  id: 42,
  title: "Blue Lines",
  normalized_title: "blue lines",
  item_type: "album" as const,
  artist_id: 1,
  artist_name: "Massive Attack",
  listen_status: "to-listen" as const,
  purchase_intent: "no" as const,
  price_cents: null,
  currency: "USD",
  notes: null,
  rating: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  listened_at: null,
  artwork_url: "/uploads/test.jpg",
  is_physical: 0,
  physical_format: null,
  label: "Wild Bunch",
  year: 1991,
  country: "UK",
  genre: "Trip-hop",
  catalogue_number: "WBRX 1",
  primary_url: null,
  primary_source: null,
  primary_link_metadata: null,
  stacks: [{ id: 1, name: "favourites" }],
  links: [],
};

describe("GET /r/:id", () => {
  beforeEach(() => {
    mockFetchItem.mockReset();
  });

  test("returns 400 for non-numeric id", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/r/abc");
    expect(res.status).toBe(400);
  });

  test("returns 404 when item not found", async () => {
    mockFetchItem.mockResolvedValue(null);
    const app = makeApp();
    const res = await app.request("http://localhost/r/999");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("Not found");
    expect(html).toContain("◄");
  });

  test("returns 200 HTML for a valid item", async () => {
    mockFetchItem.mockResolvedValue(baseItem);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type");
    expect(ct).toContain("text/html");
  });

  test("HTML contains the item title and artist", async () => {
    mockFetchItem.mockResolvedValue(baseItem);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).toContain("Blue Lines");
    expect(html).toContain("Massive Attack");
  });

  test("HTML contains metadata fields", async () => {
    mockFetchItem.mockResolvedValue(baseItem);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).toContain("1991");
    expect(html).toContain("Wild Bunch");
    expect(html).toContain("Trip-hop");
    expect(html).toContain("WBRX 1");
  });

  test("HTML contains stack chips", async () => {
    mockFetchItem.mockResolvedValue(baseItem);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).toContain("favourites");
  });

  test("HTML contains status select with correct value selected", async () => {
    mockFetchItem.mockResolvedValue(baseItem);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).toContain('value="to-listen"');
    expect(html).toContain("selected");
  });

  test("escapes HTML special characters in title", async () => {
    mockFetchItem.mockResolvedValue({
      ...baseItem,
      title: '<script>alert("xss")</script>',
      artist_name: null,
    });
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;");
  });

  test("calls fetchItem with the numeric id", async () => {
    mockFetchItem.mockResolvedValue(null);
    const app = makeApp();
    await app.request("http://localhost/r/7");
    expect(mockFetchItem).toHaveBeenCalledWith(7);
  });

  test("HTML includes item id for inline JS", async () => {
    mockFetchItem.mockResolvedValue(baseItem);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).toContain("const ITEM_ID = 42");
  });
});

describe("Apple Music secondary lookup", () => {
  test("includes lookup script when primary_source is null", async () => {
    mockFetchItem.mockResolvedValue({ ...baseItem, primary_source: null, primary_url: null });
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).toContain("apple-music-lookup");
  });

  test("includes lookup script when primary_source is discogs", async () => {
    mockFetchItem.mockResolvedValue({
      ...baseItem,
      primary_source: "discogs" as const,
      primary_url: "https://www.discogs.com/release/123",
    });
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).toContain("apple-music-lookup");
  });

  test("does not trigger lookup when primary_source is spotify", async () => {
    mockFetchItem.mockResolvedValue({
      ...baseItem,
      primary_source: "spotify" as const,
      primary_url: "https://open.spotify.com/album/abc",
    });
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    // The PLAYABLE_SOURCES check means the fetch won't run for spotify
    // We verify the JS condition won't trigger for spotify
    expect(html).toContain("PLAYABLE_SOURCES");
    expect(html).toContain('"spotify"');
  });

  test("includes secondary-links container in view mode", async () => {
    mockFetchItem.mockResolvedValue(baseItem);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).toContain('id="secondary-links"');
  });
});

describe("Bandcamp embed", () => {
  test("renders listen button when primary_source is bandcamp and metadata has album_id", async () => {
    const item = {
      ...baseItem,
      primary_url: "https://artist.bandcamp.com/album/my-album",
      primary_source: "bandcamp" as const,
      primary_link_metadata: JSON.stringify({ album_id: "1536701931", item_type: "album" }),
    };
    mockFetchItem.mockResolvedValue(item);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).toContain("bandcamp.com/EmbeddedPlayer/album=1536701931");
    expect(html).toContain("release-page__listen-btn");
  });

  test("does not render embed when primary_source is not bandcamp", async () => {
    const item = {
      ...baseItem,
      primary_url: "https://open.spotify.com/album/abc",
      primary_source: "spotify" as const,
      primary_link_metadata: null,
    };
    mockFetchItem.mockResolvedValue(item);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).not.toContain("bandcamp.com/EmbeddedPlayer");
  });

  test("does not render embed when metadata is null", async () => {
    const item = {
      ...baseItem,
      primary_url: "https://artist.bandcamp.com/album/my-album",
      primary_source: "bandcamp" as const,
      primary_link_metadata: null,
    };
    mockFetchItem.mockResolvedValue(item);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).not.toContain("bandcamp.com/EmbeddedPlayer");
  });

  test("uses track type when item_type is track", async () => {
    const item = {
      ...baseItem,
      primary_url: "https://artist.bandcamp.com/track/my-track",
      primary_source: "bandcamp" as const,
      primary_link_metadata: JSON.stringify({ album_id: "9999", item_type: "track" }),
    };
    mockFetchItem.mockResolvedValue(item);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).toContain("bandcamp.com/EmbeddedPlayer/track=9999");
  });

  test("falls back to album type when item_type not in metadata", async () => {
    const item = {
      ...baseItem,
      primary_url: "https://artist.bandcamp.com/album/my-album",
      primary_source: "bandcamp" as const,
      primary_link_metadata: JSON.stringify({ album_id: "9999" }),
    };
    mockFetchItem.mockResolvedValue(item);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).toContain("bandcamp.com/EmbeddedPlayer/album=9999");
  });
});

describe("Mixcloud embed from metadata", () => {
  test("renders Mixcloud widget iframe when primary_link_metadata has mixcloud_url", async () => {
    const item = {
      ...baseItem,
      primary_url: "https://www.worldwidefm.net/episode/breakfast-club-coco-coco-maria-24-02-2026",
      primary_source: "unknown" as const,
      primary_link_metadata: JSON.stringify({
        mixcloud_url:
          "https://www.mixcloud.com/WorldwideFM/breakfast-club-coco-coco-maria-24-02-2026/",
      }),
    };
    mockFetchItem.mockResolvedValue(item);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).toContain("mixcloud.com/widget/iframe/");
    expect(html).toContain("%2FWorldwideFM%2Fbreakfast-club-coco-coco-maria-24-02-2026%2F");
    expect(html).toContain("<iframe");
  });

  test("does not render Mixcloud widget when metadata has no mixcloud_url", async () => {
    const item = {
      ...baseItem,
      primary_url: "https://www.worldwidefm.net/episode/some-show",
      primary_source: "unknown" as const,
      primary_link_metadata: null,
    };
    mockFetchItem.mockResolvedValue(item);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).not.toContain("mixcloud.com/widget/iframe/");
  });

  test("does not render Mixcloud widget for non-mixcloud URL in metadata", async () => {
    const item = {
      ...baseItem,
      primary_url: "https://www.worldwidefm.net/episode/some-show",
      primary_source: "unknown" as const,
      primary_link_metadata: JSON.stringify({ mixcloud_url: "https://malicious.com/path/" }),
    };
    mockFetchItem.mockResolvedValue(item);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).not.toContain("mixcloud.com/widget/iframe/");
  });
});

describe("YouTube embed", () => {
  test.each([
    ["www.youtube.com", "https://www.youtube.com/watch?v=iS7-iBia7GE"],
    ["m.youtube.com (mobile)", "https://m.youtube.com/watch?v=iS7-iBia7GE"],
    ["youtu.be (shortlink)", "https://youtu.be/iS7-iBia7GE"],
  ])("renders YouTube watch button for %s URL", async (_label, primary_url) => {
    const item = {
      ...baseItem,
      primary_url,
      primary_source: "youtube" as const,
      primary_link_metadata: null,
    };
    mockFetchItem.mockResolvedValue(item);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).toContain('data-src="https://www.youtube-nocookie.com/embed/iS7-iBia7GE"');
    expect(html).toContain('data-player-type="video"');
    expect(html).toContain("release-page__listen-btn");
    expect(html).not.toContain("<iframe");
  });

  test("does not render YouTube embed when primary_source is not youtube", async () => {
    const item = {
      ...baseItem,
      primary_url: "https://open.spotify.com/album/abc",
      primary_source: "spotify" as const,
      primary_link_metadata: null,
    };
    mockFetchItem.mockResolvedValue(item);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).not.toContain("youtube-nocookie.com/embed");
  });

  test("does not render YouTube embed when primary_url is missing", async () => {
    const item = {
      ...baseItem,
      primary_url: null,
      primary_source: "youtube" as const,
      primary_link_metadata: null,
    };
    mockFetchItem.mockResolvedValue(item);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).not.toContain("youtube-nocookie.com/embed");
  });

  test("renders YouTube watch button for playlist URL", async () => {
    const item = {
      ...baseItem,
      primary_url: "https://www.youtube.com/playlist?list=PLE31AAD9114F343C4",
      primary_source: "youtube" as const,
      primary_link_metadata: null,
    };
    mockFetchItem.mockResolvedValue(item);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).toContain(
      'data-src="https://www.youtube-nocookie.com/embed/videoseries?list=PLE31AAD9114F343C4"',
    );
    expect(html).toContain('data-player-type="video"');
    expect(html).toContain("release-page__listen-btn");
    expect(html).not.toContain("<iframe");
  });

  test("shows artwork image for youtube items instead of inline video", async () => {
    const item = {
      ...baseItem,
      primary_url: "https://www.youtube.com/watch?v=iS7-iBia7GE",
      primary_source: "youtube" as const,
      artwork_url: "/uploads/yt-art.jpg",
      primary_link_metadata: null,
    };
    mockFetchItem.mockResolvedValue(item);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).toContain('src="/uploads/yt-art.jpg"');
    expect(html).toContain("release-page__artwork");
  });

  test("renders YouTube source link to original video", async () => {
    const item = {
      ...baseItem,
      primary_url: "https://www.youtube.com/playlist?list=PLE31AAD9114F343C4",
      primary_source: "youtube" as const,
      primary_link_metadata: null,
    };
    mockFetchItem.mockResolvedValue(item);
    const app = makeApp();
    const res = await app.request("http://localhost/r/42");
    const html = await res.text();
    expect(html).toContain('href="https://www.youtube.com/playlist?list=PLE31AAD9114F343C4"');
    expect(html).toContain("YouTube");
  });
});

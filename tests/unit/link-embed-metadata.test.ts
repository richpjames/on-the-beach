import { beforeEach, describe, expect, mock, test } from "bun:test";
import { scrapeLinkEmbedMetadata } from "../../server/link-embed-metadata";

const BANDCAMP_URL = "https://seekersinternational.bandcamp.com/album/thewherebetweenyou-me";

const scrape = mock();

beforeEach(() => {
  scrape.mockReset();
  scrape.mockResolvedValue(null);
});

describe("scrapeLinkEmbedMetadata", () => {
  test("stores the embed metadata scraped from a Bandcamp link", async () => {
    scrape.mockResolvedValueOnce({
      potentialTitle: "Where Between You & Me",
      embedMetadata: { album_id: "123456", item_type: "album" },
    });

    const metadata = await scrapeLinkEmbedMetadata(BANDCAMP_URL, scrape as never);

    expect(JSON.parse(metadata!)).toEqual({ album_id: "123456", item_type: "album" });
  });

  test("scrapes the normalized URL, without its query string", async () => {
    await scrapeLinkEmbedMetadata(`${BANDCAMP_URL}?from=embed`, scrape as never);

    expect(scrape).toHaveBeenCalledWith(BANDCAMP_URL, "bandcamp");
  });

  test("skips the scrape entirely for other sources", async () => {
    const metadata = await scrapeLinkEmbedMetadata(
      "https://open.spotify.com/album/1A2B3C",
      scrape as never,
    );

    expect(metadata).toBeNull();
    expect(scrape).not.toHaveBeenCalled();
  });

  test("returns null when the page has no embed metadata to give", async () => {
    scrape.mockResolvedValueOnce({ potentialTitle: "Where Between You & Me" });

    expect(await scrapeLinkEmbedMetadata(BANDCAMP_URL, scrape as never)).toBeNull();
  });

  test("returns null when the scrape finds nothing at all", async () => {
    scrape.mockResolvedValueOnce(null);

    expect(await scrapeLinkEmbedMetadata(BANDCAMP_URL, scrape as never)).toBeNull();
  });

  test("returns null rather than failing the link add when the scrape throws", async () => {
    scrape.mockRejectedValueOnce(new Error("network unreachable"));

    expect(await scrapeLinkEmbedMetadata(BANDCAMP_URL, scrape as never)).toBeNull();
  });
});

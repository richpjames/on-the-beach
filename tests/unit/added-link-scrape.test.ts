import { beforeEach, describe, expect, mock, test } from "bun:test";
import { scrapeAddedLink, type AddedLinkScrapeDeps } from "../../app/added-link-scrape";

const BANDCAMP_URL = "https://seekersinternational.bandcamp.com/album/thewherebetweenyou-me";
const SPOTIFY_URL = "https://open.spotify.com/album/1A2B3C";
const UNKNOWN_URL = "https://boomkat.com/products/where-between-you-me";

const scrape = mock();
const scrapeImage = mock();
const deps = { scrape, scrapeImage } as unknown as AddedLinkScrapeDeps;

beforeEach(() => {
  scrape.mockReset();
  scrape.mockResolvedValue(null);
  scrapeImage.mockReset();
  scrapeImage.mockResolvedValue(null);
});

describe("scrapeAddedLink — embed metadata", () => {
  test("stores the embed metadata scraped from a Bandcamp link", async () => {
    scrape.mockResolvedValueOnce({
      potentialTitle: "Where Between You & Me",
      embedMetadata: { album_id: "123456", item_type: "album" },
    });

    const { metadata } = await scrapeAddedLink(
      BANDCAMP_URL,
      { artwork: false, label: false },
      deps,
    );

    expect(JSON.parse(metadata!)).toEqual({ album_id: "123456", item_type: "album" });
  });

  test("scrapes the normalized URL, without its query string", async () => {
    await scrapeAddedLink(`${BANDCAMP_URL}?from=embed`, { artwork: false, label: false }, deps);

    expect(scrape).toHaveBeenCalledWith(BANDCAMP_URL, "bandcamp");
  });

  test("stores no metadata for a source with no player ids", async () => {
    scrape.mockResolvedValueOnce({ imageUrl: "https://i.scdn.co/image/cover.jpg" });

    const { metadata } = await scrapeAddedLink(SPOTIFY_URL, { artwork: true, label: false }, deps);

    expect(metadata).toBeNull();
  });

  test("returns null when the page has no embed metadata to give", async () => {
    scrape.mockResolvedValueOnce({ potentialTitle: "Where Between You & Me" });

    expect(
      (await scrapeAddedLink(BANDCAMP_URL, { artwork: false, label: false }, deps)).metadata,
    ).toBeNull();
  });

  test("returns null when the scrape finds nothing at all", async () => {
    scrape.mockResolvedValueOnce(null);

    expect(
      (await scrapeAddedLink(BANDCAMP_URL, { artwork: false, label: false }, deps)).metadata,
    ).toBeNull();
  });

  test("returns null rather than failing the link add when the scrape throws", async () => {
    scrape.mockRejectedValueOnce(new Error("network unreachable"));

    expect(await scrapeAddedLink(BANDCAMP_URL, { artwork: true, label: false }, deps)).toEqual({
      metadata: null,
      imageUrl: null,
      label: null,
    });
  });
});

describe("scrapeAddedLink — cover art", () => {
  test("offers the picture the linked page advertises", async () => {
    scrape.mockResolvedValueOnce({ imageUrl: "https://f4.bcbits.com/img/a123_10.jpg" });

    const { imageUrl } = await scrapeAddedLink(SPOTIFY_URL, { artwork: true, label: false }, deps);

    expect(imageUrl).toBe("https://f4.bcbits.com/img/a123_10.jpg");
  });

  test("skips the scrape entirely when the release has its own picture and the source has no player ids", async () => {
    const result = await scrapeAddedLink(SPOTIFY_URL, { artwork: false, label: false }, deps);

    expect(result).toEqual({ metadata: null, imageUrl: null, label: null });
    expect(scrape).not.toHaveBeenCalled();
    expect(scrapeImage).not.toHaveBeenCalled();
  });

  test("keeps a Bandcamp link's player ids without offering a picture the release doesn't need", async () => {
    scrape.mockResolvedValueOnce({
      imageUrl: "https://f4.bcbits.com/img/a123_10.jpg",
      embedMetadata: { album_id: "123456" },
    });

    const { metadata, imageUrl } = await scrapeAddedLink(
      BANDCAMP_URL,
      { artwork: false, label: false },
      deps,
    );

    expect(JSON.parse(metadata!)).toEqual({ album_id: "123456" });
    expect(imageUrl).toBeNull();
  });

  test("reads an unsupported link's og:image without running the release extraction", async () => {
    scrapeImage.mockResolvedValueOnce("https://boomkat.com/img/sleeve.jpg");

    const { imageUrl } = await scrapeAddedLink(UNKNOWN_URL, { artwork: true, label: false }, deps);

    expect(imageUrl).toBe("https://boomkat.com/img/sleeve.jpg");
    expect(scrape).not.toHaveBeenCalled();
  });

  test("leaves an unsupported link alone when the release already has a picture", async () => {
    const result = await scrapeAddedLink(UNKNOWN_URL, { artwork: false, label: false }, deps);

    expect(result).toEqual({ metadata: null, imageUrl: null, label: null });
    expect(scrapeImage).not.toHaveBeenCalled();
  });

  test("drops an image URL the release page couldn't render", async () => {
    scrape.mockResolvedValueOnce({ imageUrl: "/local/relative/cover.jpg" });

    expect(
      (await scrapeAddedLink(SPOTIFY_URL, { artwork: true, label: false }, deps)).imageUrl,
    ).toBeNull();
  });
});

describe("scrapeAddedLink — record label", () => {
  test("offers the label the linked page names", async () => {
    scrape.mockResolvedValueOnce({ label: "Ostinato Records" });

    const { label } = await scrapeAddedLink(BANDCAMP_URL, { artwork: false, label: true }, deps);

    expect(label).toBe("Ostinato Records");
  });

  test("runs the scrape for the label alone when nothing else is wanted", async () => {
    await scrapeAddedLink(SPOTIFY_URL, { artwork: false, label: true }, deps);

    expect(scrape).toHaveBeenCalledWith(SPOTIFY_URL, "spotify");
  });

  test("offers no label when the release already has one", async () => {
    scrape.mockResolvedValueOnce({ label: "Ostinato Records" });

    const { label } = await scrapeAddedLink(BANDCAMP_URL, { artwork: false, label: false }, deps);

    expect(label).toBeNull();
  });

  test("offers no label for a source with no scraper behind it", async () => {
    const { label } = await scrapeAddedLink(UNKNOWN_URL, { artwork: false, label: true }, deps);

    expect(label).toBeNull();
    expect(scrape).not.toHaveBeenCalled();
  });

  test("trims a label that is only whitespace", async () => {
    scrape.mockResolvedValueOnce({ label: "   " });

    const { label } = await scrapeAddedLink(BANDCAMP_URL, { artwork: false, label: true }, deps);

    expect(label).toBeNull();
  });
});

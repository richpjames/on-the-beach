import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  backfillAppleMusicLink,
  type AppleMusicBackfillDeps,
} from "../../server/apple-music-backfill";

const mockFetchItem = mock();
const mockGetExistingLink = mock();
const mockSaveLink = mock();
const mockSaveArtwork = mock();
const mockSearch = mock();

const deps: AppleMusicBackfillDeps = {
  fetchItem: mockFetchItem,
  getExistingLink: mockGetExistingLink,
  saveLink: mockSaveLink,
  saveArtwork: mockSaveArtwork,
  search: mockSearch,
};

/** A search hit for the given URL, with optional cover artwork. */
function hit(url: string, artworkUrl: string | null = null) {
  return { url, artworkUrl };
}

describe("backfillAppleMusicLink", () => {
  beforeEach(() => {
    mockFetchItem.mockReset();
    mockGetExistingLink.mockReset();
    mockSaveLink.mockReset();
    mockSaveArtwork.mockReset();
    mockSearch.mockReset();
    mockGetExistingLink.mockResolvedValue(null);
    mockSaveLink.mockResolvedValue(undefined);
    mockSaveArtwork.mockResolvedValue(undefined);
    mockSearch.mockResolvedValue(null);
  });

  test("returns item_missing when the item does not resolve", async () => {
    mockFetchItem.mockResolvedValue(null);

    const result = await backfillAppleMusicLink(99, deps);

    expect(result).toEqual({ status: "item_missing" });
    expect(mockSearch).not.toHaveBeenCalled();
  });

  test("skips when the primary link is already an Apple Music URL", async () => {
    mockFetchItem.mockResolvedValue({
      title: "The Band (Remastered)",
      artistName: "The Band",
      primarySource: null,
      primaryUrl: "https://music.apple.com/es/album/the-band-remastered/1440846597",
    });

    const result = await backfillAppleMusicLink(1, deps);

    expect(result).toEqual({ status: "skipped" });
    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockSaveLink).not.toHaveBeenCalled();
  });

  test("returns the existing Apple Music link without searching", async () => {
    mockFetchItem.mockResolvedValue({
      title: "Blue Lines",
      artistName: "Massive Attack",
      primarySource: "bandcamp",
      primaryUrl: "https://massiveattack.bandcamp.com/album/blue-lines",
    });
    mockGetExistingLink.mockResolvedValue("https://music.apple.com/gb/album/blue-lines/123");

    const result = await backfillAppleMusicLink(1, deps);

    expect(result).toEqual({
      status: "existing",
      url: "https://music.apple.com/gb/album/blue-lines/123",
    });
    expect(mockSearch).not.toHaveBeenCalled();
  });

  test("searches and saves a matching Apple Music link", async () => {
    mockFetchItem.mockResolvedValue({
      title: "Blue Lines",
      artistName: "Massive Attack",
      primarySource: "discogs",
      primaryUrl: "https://www.discogs.com/release/1",
      artworkUrl: null,
    });
    mockSearch.mockResolvedValue(hit("https://music.apple.com/gb/album/blue-lines/456"));

    const result = await backfillAppleMusicLink(7, deps);

    expect(result).toEqual({
      status: "added",
      url: "https://music.apple.com/gb/album/blue-lines/456",
    });
    expect(mockSearch).toHaveBeenCalledWith("Blue Lines", "Massive Attack");
    expect(mockSaveLink).toHaveBeenCalledWith(7, "https://music.apple.com/gb/album/blue-lines/456");
  });

  test("backfills cover art from the match when the item has none", async () => {
    mockFetchItem.mockResolvedValue({
      title: "Blue Lines",
      artistName: "Massive Attack",
      primarySource: "discogs",
      primaryUrl: "https://www.discogs.com/release/1",
      artworkUrl: null,
    });
    mockSearch.mockResolvedValue(
      hit("https://music.apple.com/gb/album/blue-lines/456", "https://cdn/cover/1200x1200bb.jpg"),
    );

    await backfillAppleMusicLink(7, deps);

    expect(mockSaveArtwork).toHaveBeenCalledWith(7, "https://cdn/cover/1200x1200bb.jpg");
  });

  test("does not overwrite cover art the item already has", async () => {
    mockFetchItem.mockResolvedValue({
      title: "Blue Lines",
      artistName: "Massive Attack",
      primarySource: "discogs",
      primaryUrl: "https://www.discogs.com/release/1",
      artworkUrl: "https://existing/cover.jpg",
    });
    mockSearch.mockResolvedValue(
      hit("https://music.apple.com/gb/album/blue-lines/456", "https://cdn/cover/1200x1200bb.jpg"),
    );

    await backfillAppleMusicLink(7, deps);

    expect(mockSaveArtwork).not.toHaveBeenCalled();
  });

  test("returns not_found when the search yields no match", async () => {
    mockFetchItem.mockResolvedValue({
      title: "Obscure Album",
      artistName: "Unknown Artist",
      primarySource: null,
      primaryUrl: null,
    });
    mockSearch.mockResolvedValue(null);

    const result = await backfillAppleMusicLink(2, deps);

    expect(result).toEqual({ status: "not_found" });
    expect(mockSaveLink).not.toHaveBeenCalled();
  });
});

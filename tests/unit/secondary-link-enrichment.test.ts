import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  enrichSecondaryLink,
  enrichSecondaryLinkInBackground,
  lookupSecondaryLinkForItem,
  type ItemInfoForLookup,
  type SecondaryLookupDeps,
} from "../../server/secondary-link-enrichment";
import type { LookupService } from "../../server/settings";

const getService = mock();
const fetchItem = mock();
const getExisting = mock();
const search = mock();
const save = mock();
const stamp = mock();

const deps: SecondaryLookupDeps = { getService, fetchItem, getExisting, search, save, stamp };

function item(overrides: Partial<ItemInfoForLookup> = {}): ItemInfoForLookup {
  return {
    title: "Blue Lines",
    artistName: "Massive Attack",
    primarySource: null,
    primaryUrl: null,
    lookupAttemptedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  getService.mockReset();
  fetchItem.mockReset();
  getExisting.mockReset();
  search.mockReset();
  save.mockReset();
  stamp.mockReset();
  getService.mockResolvedValue("apple_music" as LookupService);
  getExisting.mockResolvedValue(null);
  save.mockResolvedValue(undefined);
  stamp.mockResolvedValue(undefined);
});

describe("lookupSecondaryLinkForItem", () => {
  test("returns not_found when the item doesn't exist", async () => {
    fetchItem.mockResolvedValue(null);
    const outcome = await lookupSecondaryLinkForItem(1, deps);
    expect(outcome).toEqual({ kind: "not_found" });
    expect(search).not.toHaveBeenCalled();
  });

  test("skips items already on the active service (by source)", async () => {
    fetchItem.mockResolvedValue(item({ primarySource: "apple_music" }));
    const outcome = await lookupSecondaryLinkForItem(1, deps);
    expect(outcome).toEqual({ kind: "skipped", reason: "primary_is_active_service" });
    expect(search).not.toHaveBeenCalled();
  });

  test("skips items already on the active service (by url fragment)", async () => {
    fetchItem.mockResolvedValue(
      item({ primaryUrl: "https://music.apple.com/gb/album/blue-lines/123" }),
    );
    const outcome = await lookupSecondaryLinkForItem(1, deps);
    expect(outcome).toEqual({ kind: "skipped", reason: "primary_is_active_service" });
    expect(search).not.toHaveBeenCalled();
  });

  test("does NOT skip a Spotify primary when the active service is Apple Music", async () => {
    fetchItem.mockResolvedValue(
      item({ primarySource: "spotify", primaryUrl: "https://open.spotify.com/album/abc" }),
    );
    search.mockResolvedValue("https://music.apple.com/gb/album/blue-lines/456");
    const outcome = await lookupSecondaryLinkForItem(1, deps);
    expect(outcome.kind).toBe("result");
    expect(search).toHaveBeenCalledWith("Blue Lines", "Massive Attack", "apple_music");
    expect(save).toHaveBeenCalledWith(
      1,
      "https://music.apple.com/gb/album/blue-lines/456",
      "apple_music",
    );
  });

  test("returns an existing link on the active service without searching", async () => {
    fetchItem.mockResolvedValue(item());
    getExisting.mockResolvedValue("https://music.apple.com/gb/album/blue-lines/123");
    const outcome = await lookupSecondaryLinkForItem(1, deps);
    expect(outcome).toEqual({
      kind: "result",
      service: "apple_music",
      serviceDisplayName: "Apple Music",
      url: "https://music.apple.com/gb/album/blue-lines/123",
    });
    expect(getExisting).toHaveBeenCalledWith(1, "apple_music");
    expect(search).not.toHaveBeenCalled();
    expect(stamp).not.toHaveBeenCalled();
  });

  test("skips re-querying when a lookup was already attempted", async () => {
    fetchItem.mockResolvedValue(item({ lookupAttemptedAt: new Date() }));
    const outcome = await lookupSecondaryLinkForItem(1, deps);
    expect(outcome).toEqual({ kind: "skipped", reason: "already_attempted" });
    expect(search).not.toHaveBeenCalled();
    expect(stamp).not.toHaveBeenCalled();
  });

  test("on a hit: saves the link and stamps the marker", async () => {
    fetchItem.mockResolvedValue(item());
    search.mockResolvedValue("https://music.apple.com/gb/album/blue-lines/456");
    const outcome = await lookupSecondaryLinkForItem(5, deps);
    expect(outcome).toEqual({
      kind: "result",
      service: "apple_music",
      serviceDisplayName: "Apple Music",
      url: "https://music.apple.com/gb/album/blue-lines/456",
    });
    expect(save).toHaveBeenCalledWith(
      5,
      "https://music.apple.com/gb/album/blue-lines/456",
      "apple_music",
    );
    expect(stamp).toHaveBeenCalledWith(5);
  });

  test("on a miss: stamps the marker but saves nothing", async () => {
    fetchItem.mockResolvedValue(item());
    search.mockResolvedValue(null);
    const outcome = await lookupSecondaryLinkForItem(5, deps);
    expect(outcome).toEqual({
      kind: "result",
      service: "apple_music",
      serviceDisplayName: "Apple Music",
      url: null,
    });
    expect(save).not.toHaveBeenCalled();
    expect(stamp).toHaveBeenCalledWith(5);
  });

  test("uses the active service from settings (Spotify)", async () => {
    getService.mockResolvedValue("spotify" as LookupService);
    fetchItem.mockResolvedValue(item({ primarySource: "apple_music" }));
    search.mockResolvedValue("https://open.spotify.com/album/xyz");
    const outcome = await lookupSecondaryLinkForItem(9, deps);
    expect(outcome).toMatchObject({
      kind: "result",
      service: "spotify",
      serviceDisplayName: "Spotify",
      url: "https://open.spotify.com/album/xyz",
    });
    expect(getExisting).toHaveBeenCalledWith(9, "spotify");
    expect(search).toHaveBeenCalledWith("Blue Lines", "Massive Attack", "spotify");
    expect(save).toHaveBeenCalledWith(9, "https://open.spotify.com/album/xyz", "spotify");
  });
});

describe("enrichSecondaryLink", () => {
  test("unwraps a hit to the URL", async () => {
    fetchItem.mockResolvedValue(item());
    search.mockResolvedValue("https://music.apple.com/gb/album/blue-lines/456");
    expect(await enrichSecondaryLink(5, deps)).toBe(
      "https://music.apple.com/gb/album/blue-lines/456",
    );
  });

  test("unwraps a skip to null", async () => {
    fetchItem.mockResolvedValue(item({ primarySource: "apple_music" }));
    expect(await enrichSecondaryLink(5, deps)).toBeNull();
  });
});

describe("enrichSecondaryLinkInBackground", () => {
  test("no-ops under OTB_DISABLE_EXTERNAL_LOOKUPS", () => {
    const prev = process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
    process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";
    try {
      // Should return synchronously without scheduling any DB work.
      expect(enrichSecondaryLinkInBackground(1)).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
      else process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = prev;
    }
  });
});

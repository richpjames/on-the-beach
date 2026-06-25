import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  enrichAppleMusicLink,
  enrichAppleMusicLinkInBackground,
  lookupAppleMusicForItem,
  type AppleMusicLookupDeps,
  type ItemInfoForLookup,
} from "../../server/apple-music-enrichment";

const fetchItem = mock();
const getExisting = mock();
const search = mock();
const save = mock();
const stamp = mock();

const deps: AppleMusicLookupDeps = { fetchItem, getExisting, search, save, stamp };

function item(overrides: Partial<ItemInfoForLookup> = {}): ItemInfoForLookup {
  return {
    title: "Blue Lines",
    artistName: "Massive Attack",
    primarySource: null,
    primaryUrl: null,
    appleMusicLookupAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  fetchItem.mockReset();
  getExisting.mockReset();
  search.mockReset();
  save.mockReset();
  stamp.mockReset();
  getExisting.mockResolvedValue(null);
  save.mockResolvedValue(undefined);
  stamp.mockResolvedValue(undefined);
});

describe("lookupAppleMusicForItem", () => {
  test("returns not_found when the item doesn't exist", async () => {
    fetchItem.mockResolvedValue(null);
    const outcome = await lookupAppleMusicForItem(1, deps);
    expect(outcome).toEqual({ kind: "not_found" });
    expect(search).not.toHaveBeenCalled();
  });

  test("skips items that are themselves Apple Music links", async () => {
    fetchItem.mockResolvedValue(
      item({ primaryUrl: "https://music.apple.com/gb/album/blue-lines/123" }),
    );
    const outcome = await lookupAppleMusicForItem(1, deps);
    expect(outcome).toEqual({ kind: "skipped", reason: "apple_music_primary" });
    expect(search).not.toHaveBeenCalled();
  });

  test("returns an existing Apple Music link without searching", async () => {
    fetchItem.mockResolvedValue(item());
    getExisting.mockResolvedValue("https://music.apple.com/gb/album/blue-lines/123");
    const outcome = await lookupAppleMusicForItem(1, deps);
    expect(outcome).toEqual({
      kind: "result",
      url: "https://music.apple.com/gb/album/blue-lines/123",
    });
    expect(search).not.toHaveBeenCalled();
    expect(stamp).not.toHaveBeenCalled();
  });

  test("skips re-querying when a lookup was already attempted", async () => {
    fetchItem.mockResolvedValue(item({ appleMusicLookupAt: new Date() }));
    const outcome = await lookupAppleMusicForItem(1, deps);
    expect(outcome).toEqual({ kind: "skipped", reason: "already_attempted" });
    expect(search).not.toHaveBeenCalled();
    expect(stamp).not.toHaveBeenCalled();
  });

  test("on a hit: saves the link and stamps the marker", async () => {
    fetchItem.mockResolvedValue(item());
    search.mockResolvedValue("https://music.apple.com/gb/album/blue-lines/456");
    const outcome = await lookupAppleMusicForItem(5, deps);
    expect(outcome).toEqual({
      kind: "result",
      url: "https://music.apple.com/gb/album/blue-lines/456",
    });
    expect(search).toHaveBeenCalledWith("Blue Lines", "Massive Attack");
    expect(save).toHaveBeenCalledWith(5, "https://music.apple.com/gb/album/blue-lines/456");
    expect(stamp).toHaveBeenCalledWith(5);
  });

  test("on a miss: stamps the marker but saves nothing", async () => {
    fetchItem.mockResolvedValue(item());
    search.mockResolvedValue(null);
    const outcome = await lookupAppleMusicForItem(5, deps);
    expect(outcome).toEqual({ kind: "result", url: null });
    expect(save).not.toHaveBeenCalled();
    expect(stamp).toHaveBeenCalledWith(5);
  });
});

describe("enrichAppleMusicLink", () => {
  test("unwraps a hit to the URL", async () => {
    fetchItem.mockResolvedValue(item());
    search.mockResolvedValue("https://music.apple.com/gb/album/blue-lines/456");
    expect(await enrichAppleMusicLink(5, deps)).toBe(
      "https://music.apple.com/gb/album/blue-lines/456",
    );
  });

  test("unwraps a skip to null", async () => {
    fetchItem.mockResolvedValue(
      item({ primaryUrl: "https://music.apple.com/gb/album/blue-lines/123" }),
    );
    expect(await enrichAppleMusicLink(5, deps)).toBeNull();
  });
});

describe("enrichAppleMusicLinkInBackground", () => {
  test("no-ops under OTB_DISABLE_EXTERNAL_LOOKUPS", () => {
    const prev = process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
    process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";
    try {
      // Should return synchronously without scheduling any DB work.
      expect(enrichAppleMusicLinkInBackground(1)).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
      else process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = prev;
    }
  });

  test("no-ops for items that are themselves Apple Music links", () => {
    const prev = process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
    delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
    try {
      expect(enrichAppleMusicLinkInBackground(1, "apple_music")).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = prev;
    }
  });
});

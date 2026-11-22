import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  appleMusicRepairTarget,
  defaultSecondaryLookupDeps,
  enrichSecondaryLink,
  enrichSecondaryLinkInBackground,
  findAppleMusicUrlViaMusicBrainz,
  lookupSecondaryLinkForItem,
  pickAppleMusicReleaseUrl,
  pickBandcampReleaseUrl,
  type ItemInfoForLookup,
  type SecondaryLookupDeps,
} from "../../app/secondary-link-enrichment";
import type { MbUrlRelation } from "../../adapters/musicbrainz/index";
import type { LookupService } from "../../app/settings";

const getService = mock();
const fetchItem = mock();
const getExisting = mock();
const search = mock();
const searchFallback = mock();
const findAppleMusicLink = mock();
const findBandcampLink = mock();
const save = mock();
const saveArtwork = mock();
const saveLabel = mock();
const stamp = mock();

const deps: SecondaryLookupDeps = {
  getService,
  fetchItem,
  getExisting,
  search,
  searchFallback,
  findAppleMusicLink,
  findBandcampLink,
  save,
  saveArtwork,
  saveLabel,
  stamp,
};

function item(overrides: Partial<ItemInfoForLookup> = {}): ItemInfoForLookup {
  return {
    title: "Blue Lines",
    artistName: "Massive Attack",
    primarySource: null,
    primaryUrl: null,
    artworkUrl: null,
    label: null,
    lookupAttemptedAt: null,
    musicbrainzReleaseId: null,
    musicbrainzReleaseGroupId: null,
    ...overrides,
  };
}

/** A search hit for the given URL, with optional cover artwork and label. */
function hit(url: string, artworkUrl: string | null = null, label: string | null = null) {
  return { url, artworkUrl, label };
}

beforeEach(() => {
  getService.mockReset();
  fetchItem.mockReset();
  getExisting.mockReset();
  search.mockReset();
  searchFallback.mockReset();
  findAppleMusicLink.mockReset();
  findBandcampLink.mockReset();
  save.mockReset();
  saveArtwork.mockReset();
  saveLabel.mockReset();
  stamp.mockReset();
  getService.mockResolvedValue("apple_music" as LookupService);
  getExisting.mockResolvedValue(null);
  searchFallback.mockResolvedValue(null);
  findAppleMusicLink.mockResolvedValue(null);
  findBandcampLink.mockResolvedValue(null);
  save.mockResolvedValue(undefined);
  saveArtwork.mockResolvedValue(undefined);
  saveLabel.mockResolvedValue(undefined);
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
    search.mockResolvedValue(hit("https://music.apple.com/gb/album/blue-lines/456"));
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
    search.mockResolvedValue(hit("https://music.apple.com/gb/album/blue-lines/456"));
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

  test("on a hit with artwork: backfills the item's cover when it has none", async () => {
    fetchItem.mockResolvedValue(item({ artworkUrl: null }));
    search.mockResolvedValue(
      hit("https://music.apple.com/gb/album/blue-lines/456", "https://cdn/cover/1200x1200bb.jpg"),
    );
    await lookupSecondaryLinkForItem(5, deps);
    expect(saveArtwork).toHaveBeenCalledWith(5, "https://cdn/cover/1200x1200bb.jpg");
  });

  test("does not overwrite artwork the item already has", async () => {
    fetchItem.mockResolvedValue(item({ artworkUrl: "https://existing/cover.jpg" }));
    search.mockResolvedValue(
      hit("https://music.apple.com/gb/album/blue-lines/456", "https://cdn/cover/1200x1200bb.jpg"),
    );
    await lookupSecondaryLinkForItem(5, deps);
    expect(saveArtwork).not.toHaveBeenCalled();
  });

  test("saves no artwork when the hit carries none", async () => {
    fetchItem.mockResolvedValue(item({ artworkUrl: null }));
    search.mockResolvedValue(hit("https://music.apple.com/gb/album/blue-lines/456", null));
    await lookupSecondaryLinkForItem(5, deps);
    expect(saveArtwork).not.toHaveBeenCalled();
  });

  test("on a hit with a label: backfills the item's label when it has none", async () => {
    fetchItem.mockResolvedValue(item({ label: null }));
    search.mockResolvedValue(
      hit("https://music.apple.com/gb/album/blue-lines/456", null, "Wild Bunch Records"),
    );
    await lookupSecondaryLinkForItem(5, deps);
    expect(saveLabel).toHaveBeenCalledWith(5, "Wild Bunch Records");
  });

  test("does not overwrite a label the item already has", async () => {
    fetchItem.mockResolvedValue(item({ label: "Wild Bunch" }));
    search.mockResolvedValue(
      hit("https://music.apple.com/gb/album/blue-lines/456", null, "Virgin"),
    );
    await lookupSecondaryLinkForItem(5, deps);
    expect(saveLabel).not.toHaveBeenCalled();
  });

  test("saves no label when the hit carries none", async () => {
    fetchItem.mockResolvedValue(item({ label: null }));
    search.mockResolvedValue(hit("https://music.apple.com/gb/album/blue-lines/456"));
    await lookupSecondaryLinkForItem(5, deps);
    expect(saveLabel).not.toHaveBeenCalled();
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

  test("on a hit: never consults the YouTube fallback", async () => {
    fetchItem.mockResolvedValue(item());
    search.mockResolvedValue(hit("https://music.apple.com/gb/album/blue-lines/456"));
    await lookupSecondaryLinkForItem(5, deps);
    expect(searchFallback).not.toHaveBeenCalled();
  });

  test("uses the active service from settings (Spotify)", async () => {
    getService.mockResolvedValue("spotify" as LookupService);
    fetchItem.mockResolvedValue(item({ primarySource: "apple_music" }));
    search.mockResolvedValue(hit("https://open.spotify.com/album/xyz"));
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

describe("MusicBrainz Apple Music relations", () => {
  const attachedUrl = "https://music.apple.com/gb/album/i-wonder-if-you-know-single/6769093260";

  test("an editor-attached link beats the catalogue search", async () => {
    fetchItem.mockResolvedValue(item({ musicbrainzReleaseId: "r1" }));
    findAppleMusicLink.mockResolvedValue(hit(attachedUrl));

    const outcome = await lookupSecondaryLinkForItem(686, deps);

    expect(outcome).toEqual({
      kind: "result",
      service: "apple_music",
      serviceDisplayName: "Apple Music",
      url: attachedUrl,
    });
    expect(findAppleMusicLink).toHaveBeenCalledWith(
      expect.objectContaining({ musicbrainzReleaseId: "r1" }),
    );
    expect(search).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith(686, attachedUrl, "apple_music");
    expect(stamp).toHaveBeenCalledWith(686);
  });

  test("an attached hit may fill the item's artwork and label", async () => {
    fetchItem.mockResolvedValue(item({ artworkUrl: null, label: null }));
    findAppleMusicLink.mockResolvedValue(
      hit(attachedUrl, "https://cdn/cover/1200x1200bb.jpg", "Because Music"),
    );

    await lookupSecondaryLinkForItem(686, deps);

    expect(saveArtwork).toHaveBeenCalledWith(686, "https://cdn/cover/1200x1200bb.jpg");
    expect(saveLabel).toHaveBeenCalledWith(686, "Because Music");
  });

  test("does not overwrite artwork or label the item already has", async () => {
    fetchItem.mockResolvedValue(
      item({ artworkUrl: "https://existing/cover.jpg", label: "Existing" }),
    );
    findAppleMusicLink.mockResolvedValue(
      hit(attachedUrl, "https://cdn/cover.jpg", "Because Music"),
    );

    await lookupSecondaryLinkForItem(686, deps);

    expect(saveArtwork).not.toHaveBeenCalled();
    expect(saveLabel).not.toHaveBeenCalled();
  });

  test("falls through to the catalogue search when MusicBrainz names no page", async () => {
    fetchItem.mockResolvedValue(item({ musicbrainzReleaseId: "r1" }));
    findAppleMusicLink.mockResolvedValue(null);
    search.mockResolvedValue(hit("https://music.apple.com/gb/album/blue-lines/456"));

    const outcome = await lookupSecondaryLinkForItem(5, deps);

    expect(search).toHaveBeenCalledWith("Blue Lines", "Massive Attack", "apple_music");
    expect(outcome).toMatchObject({ url: "https://music.apple.com/gb/album/blue-lines/456" });
  });

  test("not consulted when the active service is Spotify", async () => {
    getService.mockResolvedValue("spotify" as LookupService);
    fetchItem.mockResolvedValue(item({ musicbrainzReleaseId: "r1" }));
    search.mockResolvedValue(hit("https://open.spotify.com/album/xyz"));

    await lookupSecondaryLinkForItem(9, deps);

    expect(findAppleMusicLink).not.toHaveBeenCalled();
  });

  test("not consulted when a lookup was already attempted", async () => {
    fetchItem.mockResolvedValue(item({ lookupAttemptedAt: new Date() }));

    await lookupSecondaryLinkForItem(5, deps);

    expect(findAppleMusicLink).not.toHaveBeenCalled();
  });
});

describe("YouTube fallback", () => {
  const video = "https://www.youtube.com/watch?v=abc123";

  test("saves a confident YouTube hit when the active service has nothing", async () => {
    fetchItem.mockResolvedValue(item());
    search.mockResolvedValue(null);
    searchFallback.mockResolvedValue(hit(video));

    const outcome = await lookupSecondaryLinkForItem(7, deps);

    expect(outcome).toEqual({
      kind: "result",
      service: "apple_music",
      serviceDisplayName: "YouTube",
      url: video,
      via: "fallback",
    });
    expect(searchFallback).toHaveBeenCalledWith("Blue Lines", "Massive Attack");
    expect(save).toHaveBeenCalledWith(7, video, "youtube");
    expect(stamp).toHaveBeenCalledWith(7);
  });

  test("reports a miss when the fallback isn't confident either", async () => {
    fetchItem.mockResolvedValue(item());
    search.mockResolvedValue(null);
    searchFallback.mockResolvedValue(null);

    const outcome = await lookupSecondaryLinkForItem(7, deps);

    expect(outcome).toEqual({
      kind: "result",
      service: "apple_music",
      serviceDisplayName: "Apple Music",
      url: null,
    });
    expect(save).not.toHaveBeenCalled();
  });

  test("never takes artwork from a fallback hit", async () => {
    fetchItem.mockResolvedValue(item({ artworkUrl: null }));
    search.mockResolvedValue(null);
    searchFallback.mockResolvedValue(hit(video, "https://i.ytimg.com/vi/abc123/maxres.jpg"));

    await lookupSecondaryLinkForItem(7, deps);

    expect(saveArtwork).not.toHaveBeenCalled();
  });

  test("skips the fallback for an item that is already a YouTube link", async () => {
    fetchItem.mockResolvedValue(item({ primarySource: "youtube", primaryUrl: video }));
    search.mockResolvedValue(null);

    const outcome = await lookupSecondaryLinkForItem(7, deps);

    expect(searchFallback).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ url: null, serviceDisplayName: "Apple Music" });
  });

  test("skips the fallback when the item already carries a YouTube link", async () => {
    fetchItem.mockResolvedValue(item());
    search.mockResolvedValue(null);
    getExisting.mockImplementation(async (_id: number, source: string) =>
      source === "youtube" ? video : null,
    );

    const outcome = await lookupSecondaryLinkForItem(7, deps);

    expect(searchFallback).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ url: null });
  });

  test("also backs up a Spotify lookup", async () => {
    getService.mockResolvedValue("spotify" as LookupService);
    fetchItem.mockResolvedValue(item());
    search.mockResolvedValue(null);
    searchFallback.mockResolvedValue(hit(video));

    const outcome = await lookupSecondaryLinkForItem(8, deps);

    expect(outcome).toMatchObject({ service: "spotify", url: video, via: "fallback" });
    expect(save).toHaveBeenCalledWith(8, video, "youtube");
  });
});

describe("Bandcamp fallback", () => {
  const bandcampUrl = "https://gavsborg.bandcamp.com/album/1-hour-service";

  test("saves a Bandcamp hit when the active service has nothing, before YouTube", async () => {
    fetchItem.mockResolvedValue(
      item({ musicbrainzReleaseGroupId: "dc850e6a-81e5-4f34-bbcd-16349b4cc618" }),
    );
    search.mockResolvedValue(null);
    findBandcampLink.mockResolvedValue(hit(bandcampUrl, "https://bandcamp/cover.jpg"));

    const outcome = await lookupSecondaryLinkForItem(7, deps);

    expect(outcome).toEqual({
      kind: "result",
      service: "apple_music",
      serviceDisplayName: "Bandcamp",
      url: bandcampUrl,
      via: "fallback",
    });
    expect(findBandcampLink).toHaveBeenCalledWith(
      expect.objectContaining({
        musicbrainzReleaseGroupId: "dc850e6a-81e5-4f34-bbcd-16349b4cc618",
      }),
    );
    expect(save).toHaveBeenCalledWith(7, bandcampUrl, "bandcamp");
    expect(searchFallback).not.toHaveBeenCalled();
    expect(stamp).toHaveBeenCalledWith(7);
  });

  test("a Bandcamp hit may fill the item's artwork — its cover is the release's own", async () => {
    fetchItem.mockResolvedValue(item({ artworkUrl: null }));
    search.mockResolvedValue(null);
    findBandcampLink.mockResolvedValue(hit(bandcampUrl, "https://bandcamp/cover.jpg"));

    await lookupSecondaryLinkForItem(7, deps);

    expect(saveArtwork).toHaveBeenCalledWith(7, "https://bandcamp/cover.jpg");
  });

  test("a Bandcamp hit may fill the item's label — the credits name the imprint", async () => {
    fetchItem.mockResolvedValue(item({ label: null }));
    search.mockResolvedValue(null);
    findBandcampLink.mockResolvedValue(
      hit(bandcampUrl, "https://bandcamp/cover.jpg", "Ostinato Records"),
    );

    await lookupSecondaryLinkForItem(7, deps);

    expect(saveLabel).toHaveBeenCalledWith(7, "Ostinato Records");
  });

  test("does not overwrite artwork the item already has", async () => {
    fetchItem.mockResolvedValue(item({ artworkUrl: "https://existing/cover.jpg" }));
    search.mockResolvedValue(null);
    findBandcampLink.mockResolvedValue(hit(bandcampUrl, "https://bandcamp/cover.jpg"));

    await lookupSecondaryLinkForItem(7, deps);

    expect(saveArtwork).not.toHaveBeenCalled();
  });

  test("saves the link even when the page carried no artwork", async () => {
    fetchItem.mockResolvedValue(item());
    search.mockResolvedValue(null);
    findBandcampLink.mockResolvedValue(hit(bandcampUrl, null));

    const outcome = await lookupSecondaryLinkForItem(7, deps);

    expect(outcome).toMatchObject({ url: bandcampUrl, serviceDisplayName: "Bandcamp" });
    expect(saveArtwork).not.toHaveBeenCalled();
  });

  test("skips Bandcamp for an item that is already a Bandcamp link", async () => {
    fetchItem.mockResolvedValue(item({ primarySource: "bandcamp", primaryUrl: bandcampUrl }));
    search.mockResolvedValue(null);

    await lookupSecondaryLinkForItem(7, deps);

    expect(findBandcampLink).not.toHaveBeenCalled();
  });

  test("skips Bandcamp when the item already carries a Bandcamp link", async () => {
    fetchItem.mockResolvedValue(item());
    search.mockResolvedValue(null);
    getExisting.mockImplementation(async (_id: number, source: string) =>
      source === "bandcamp" ? bandcampUrl : null,
    );

    await lookupSecondaryLinkForItem(7, deps);

    expect(findBandcampLink).not.toHaveBeenCalled();
  });

  test("falls through to YouTube when MusicBrainz names no Bandcamp page", async () => {
    const video = "https://www.youtube.com/watch?v=abc123";
    fetchItem.mockResolvedValue(item());
    search.mockResolvedValue(null);
    findBandcampLink.mockResolvedValue(null);
    searchFallback.mockResolvedValue(hit(video));

    const outcome = await lookupSecondaryLinkForItem(7, deps);

    expect(outcome).toMatchObject({ url: video, serviceDisplayName: "YouTube", via: "fallback" });
    expect(save).toHaveBeenCalledWith(7, video, "youtube");
  });

  test("on a hit: never consults the Bandcamp fallback", async () => {
    fetchItem.mockResolvedValue(item());
    search.mockResolvedValue(hit("https://music.apple.com/gb/album/blue-lines/456"));

    await lookupSecondaryLinkForItem(5, deps);

    expect(findBandcampLink).not.toHaveBeenCalled();
  });
});

describe("pickBandcampReleaseUrl", () => {
  test("ranks a free-streaming relation above purchase for download", () => {
    const relations: MbUrlRelation[] = [
      { type: "purchase for download", url: "https://gavsborg.bandcamp.com/album/purchase-page" },
      { type: "free streaming", url: "https://gavsborg.bandcamp.com/album/stream-page" },
    ];
    expect(pickBandcampReleaseUrl(relations)).toBe(
      "https://gavsborg.bandcamp.com/album/stream-page",
    );
  });

  test("ignores Bandcamp homepages — the artist's page is not this record", () => {
    const relations: MbUrlRelation[] = [
      { type: "discography", url: "https://gavsborg.bandcamp.com/music" },
      { type: null, url: "https://gavsborg.bandcamp.com" },
    ];
    expect(pickBandcampReleaseUrl(relations)).toBeNull();
  });

  test("ignores non-Bandcamp relations", () => {
    const relations: MbUrlRelation[] = [
      { type: "free streaming", url: "https://open.spotify.com/album/xyz" },
      { type: "purchase for download", url: "https://store.label.com/record" },
    ];
    expect(pickBandcampReleaseUrl(relations)).toBeNull();
  });

  test("accepts a track page when that is all the group carries", () => {
    const relations: MbUrlRelation[] = [
      { type: null, url: "https://gavsborg.bandcamp.com/track/one-song" },
    ];
    expect(pickBandcampReleaseUrl(relations)).toBe("https://gavsborg.bandcamp.com/track/one-song");
  });
});

describe("pickAppleMusicReleaseUrl", () => {
  test("takes the album the relations name", () => {
    const relations: MbUrlRelation[] = [
      { type: "streaming", url: "https://music.apple.com/gb/album/6769093260" },
    ];
    expect(pickAppleMusicReleaseUrl(relations)).toBe("https://music.apple.com/gb/album/6769093260");
  });

  test("prefers an album over a lone song or playlist", () => {
    const relations: MbUrlRelation[] = [
      { type: "streaming", url: "https://music.apple.com/gb/song/foo/2" },
      { type: "streaming", url: "https://music.apple.com/gb/album/bar/1" },
    ];
    expect(pickAppleMusicReleaseUrl(relations)).toBe("https://music.apple.com/gb/album/bar/1");
  });

  test("reduces a track deep-link to its album — the release plays whole", () => {
    const relations: MbUrlRelation[] = [
      { type: "streaming", url: "https://music.apple.com/gb/album/my-song/952587922?i=952587944" },
    ];
    expect(pickAppleMusicReleaseUrl(relations)).toBe(
      "https://music.apple.com/gb/album/my-song/952587922",
    );
  });

  test("falls back to a song or playlist when no album is named", () => {
    expect(
      pickAppleMusicReleaseUrl([
        { type: "streaming", url: "https://music.apple.com/gb/song/foo/2" },
      ]),
    ).toBe("https://music.apple.com/gb/song/foo/2");
    expect(
      pickAppleMusicReleaseUrl([
        { type: "streaming", url: "https://music.apple.com/gb/playlist/foo/pl.u-abc" },
      ]),
    ).toBe("https://music.apple.com/gb/playlist/foo/pl.u-abc");
  });

  test("ignores artist pages and non-Apple-Music relations", () => {
    const relations: MbUrlRelation[] = [
      { type: "streaming", url: "https://open.spotify.com/album/xyz" },
      { type: "official homepage", url: "https://music.apple.com/gb/artist/foo/111" },
    ];
    expect(pickAppleMusicReleaseUrl(relations)).toBeNull();
  });

  test("ties keep MusicBrainz's own ordering", () => {
    const relations: MbUrlRelation[] = [
      { type: "purchase for download", url: "https://music.apple.com/gb/album/first/1" },
      { type: "streaming", url: "https://music.apple.com/gb/album/second/2" },
    ];
    expect(pickAppleMusicReleaseUrl(relations)).toBe("https://music.apple.com/gb/album/first/1");
  });
});

describe("findAppleMusicUrlViaMusicBrainz", () => {
  // The lookup no-ops under OTB_DISABLE_EXTERNAL_LOOKUPS, and a stray copy of
  // the flag — left in the shared process by whichever test file `bun test`
  // happened to run first — would make every assertion here read null.
  // Guarantee it's off for these tests rather than depending on file order.
  let flagBefore: string | undefined;

  beforeEach(() => {
    flagBefore = process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
    delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
  });

  afterEach(() => {
    mock.restore();
    if (flagBefore === undefined) delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
    else process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = flagBefore;
  });

  function mbResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  }

  test("no MusicBrainz ids means no request and no link", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    const url = await findAppleMusicUrlViaMusicBrainz({
      musicbrainzReleaseId: null,
      musicbrainzReleaseGroupId: null,
    });
    expect(url).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("no-ops under OTB_DISABLE_EXTERNAL_LOOKUPS", async () => {
    const prev = process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
    process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";
    try {
      const fetchSpy = spyOn(globalThis, "fetch");
      const url = await findAppleMusicUrlViaMusicBrainz({
        musicbrainzReleaseId: "r1",
        musicbrainzReleaseGroupId: null,
      });
      expect(url).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
      else process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = prev;
    }
  });

  test("asks the release's own relations first", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mbResponse({
        relations: [
          { type: "streaming", url: { resource: "https://music.apple.com/gb/album/6769093260" } },
        ],
      }),
    );

    const url = await findAppleMusicUrlViaMusicBrainz({
      musicbrainzReleaseId: "r1",
      musicbrainzReleaseGroupId: "rg1",
    });

    expect(url).toBe("https://music.apple.com/gb/album/6769093260");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toContain("/release/r1?");
  });

  test("falls back to the release group when the release names no Apple Music page", async () => {
    const fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        mbResponse({
          relations: [
            { type: "streaming", url: { resource: "https://open.spotify.com/album/xyz" } },
          ],
        }),
      )
      .mockResolvedValueOnce(
        mbResponse({
          relations: [
            { type: "streaming", url: { resource: "https://music.apple.com/gb/album/1" } },
          ],
        }),
      );

    const url = await findAppleMusicUrlViaMusicBrainz({
      musicbrainzReleaseId: "r1",
      musicbrainzReleaseGroupId: "rg1",
    });

    expect(url).toBe("https://music.apple.com/gb/album/1");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1]?.[0]).toContain("/release-group/rg1?");
  });

  test("resolves the group from the release when only the release id is known", async () => {
    const fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mbResponse({ relations: [] }))
      .mockResolvedValueOnce(mbResponse({ "release-group": { id: "rg1" } }))
      .mockResolvedValueOnce(
        mbResponse({
          relations: [
            { type: "streaming", url: { resource: "https://music.apple.com/gb/album/1" } },
          ],
        }),
      );

    const url = await findAppleMusicUrlViaMusicBrainz({
      musicbrainzReleaseId: "r1",
      musicbrainzReleaseGroupId: null,
    });

    expect(url).toBe("https://music.apple.com/gb/album/1");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls[1]?.[0]).toContain("inc=release-groups");
    expect(fetchSpy.mock.calls[2]?.[0]).toContain("/release-group/rg1?");
  });

  test("a failed request is a miss, not a throw", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(new Response("rate limited", { status: 503 }));

    const url = await findAppleMusicUrlViaMusicBrainz({
      musicbrainzReleaseId: "r1",
      musicbrainzReleaseGroupId: null,
    });

    expect(url).toBeNull();
  });

  test("a throttled release lookup still tries the release group", async () => {
    // The release's 503 must not take the group's answer down with it.
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/release/r1")) {
        return new Response("rate limited", { status: 503 });
      }
      return mbResponse({
        relations: [{ type: "streaming", url: { resource: "https://music.apple.com/gb/album/1" } }],
      });
    });

    const url = await findAppleMusicUrlViaMusicBrainz({
      musicbrainzReleaseId: "r1",
      musicbrainzReleaseGroupId: "rg1",
    });

    expect(url).toBe("https://music.apple.com/gb/album/1");
    expect(
      fetchSpy.mock.calls.some((call) => String(call[0]).includes("/release-group/rg1?")),
    ).toBe(true);
  });

  test("a release that no longer exists still tries the release group", async () => {
    // A merged or removed release answers 404; the group often carries the
    // same streaming links.
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/release/r1")) {
        return new Response("not found", { status: 404 });
      }
      return mbResponse({
        relations: [{ type: "streaming", url: { resource: "https://music.apple.com/gb/album/1" } }],
      });
    });

    const url = await findAppleMusicUrlViaMusicBrainz({
      musicbrainzReleaseId: "r1",
      musicbrainzReleaseGroupId: "rg1",
    });

    expect(url).toBe("https://music.apple.com/gb/album/1");
    expect(
      fetchSpy.mock.calls.some((call) => String(call[0]).includes("/release-group/rg1?")),
    ).toBe(true);
  });
});

describe("defaultFindAppleMusicLink", () => {
  // Same stray-flag hazard as findAppleMusicUrlViaMusicBrainz above.
  let flagBefore: string | undefined;

  beforeEach(() => {
    flagBefore = process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
    delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
  });

  afterEach(() => {
    mock.restore();
    if (flagBefore === undefined) delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
    else process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = flagBefore;
  });

  test("scrapes the attached page for cover art and label", async () => {
    const fetchSpy = spyOn(globalThis, "fetch")
      // MusicBrainz release url-rels.
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            relations: [
              {
                type: "streaming",
                url: { resource: "https://music.apple.com/gb/album/6769093260" },
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      )
      // Apple's oEmbed answers complete, so no page fetch is needed.
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            title: "I Wonder If You Know - Single",
            author_name: "Alok & SOMETHING ELSE",
            thumbnail_url: "https://is1-ssl.mzstatic.com/image/thumb/abc/100x100bb.jpg",
          }),
          { headers: { "content-type": "application/json" } },
        ),
      )
      // The iTunes lookup still runs for the label oEmbed never names.
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                collectionName: "I Wonder If You Know - Single",
                copyright: "℗ 2026 Because Music",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );

    const hit = await defaultSecondaryLookupDeps.findAppleMusicLink(
      item({ musicbrainzReleaseId: "r1" }),
    );

    expect(hit).toEqual({
      url: "https://music.apple.com/gb/album/6769093260",
      artworkUrl: "https://is1-ssl.mzstatic.com/image/thumb/abc/1200x1200bb.jpg",
      label: "Because Music",
    });
    expect(fetchSpy.mock.calls[1]?.[0]).toContain("music.apple.com/api/oembed");
    expect(fetchSpy.mock.calls[2]?.[0]).toContain("itunes.apple.com/lookup");
  });
});

describe("appleMusicRepairTarget", () => {
  const stored = "https://music.apple.com/gb/album/my-song/952587922?i=952587944";

  test("the MusicBrainz-attached page replaces a wrong link", () => {
    expect(appleMusicRepairTarget(stored, "https://music.apple.com/gb/album/6769093260")).toBe(
      "https://music.apple.com/gb/album/6769093260",
    );
  });

  test("a link that already matches MusicBrainz is left alone", () => {
    const url = "https://music.apple.com/gb/album/6769093260";
    expect(appleMusicRepairTarget(url, url)).toBeNull();
  });

  test("without MusicBrainz, a track deep-link is reduced to its album", () => {
    expect(appleMusicRepairTarget(stored, null)).toBe(
      "https://music.apple.com/gb/album/my-song/952587922",
    );
  });

  test("a clean album link with no MusicBrainz page is left alone", () => {
    expect(
      appleMusicRepairTarget("https://music.apple.com/gb/album/my-song/952587922", null),
    ).toBeNull();
  });

  test("a song URL with no MusicBrainz page is left alone — no album to reduce to", () => {
    expect(appleMusicRepairTarget("https://music.apple.com/gb/song/foo/2", null)).toBeNull();
  });

  test("an album link is never downgraded to the song MusicBrainz names", () => {
    // The repair must not trade whole-record playback for one track: MB
    // naming only a song leaves an existing album link alone.
    expect(
      appleMusicRepairTarget(
        "https://music.apple.com/gb/album/my-song/952587922",
        "https://music.apple.com/gb/song/foo/2",
      ),
    ).toBeNull();
  });

  test("an album link is never downgraded to the playlist MusicBrainz names", () => {
    expect(
      appleMusicRepairTarget(
        "https://music.apple.com/gb/album/my-song/952587922",
        "https://music.apple.com/gb/playlist/foo/pl.u-abc",
      ),
    ).toBeNull();
  });

  test("a deep-link reduces to its own album even when MusicBrainz names only a song", () => {
    expect(appleMusicRepairTarget(stored, "https://music.apple.com/gb/song/foo/2")).toBe(
      "https://music.apple.com/gb/album/my-song/952587922",
    );
  });

  test("a stored song link adopts the song MusicBrainz names — no album to preserve", () => {
    expect(
      appleMusicRepairTarget(
        "https://music.apple.com/gb/song/wrong/1",
        "https://music.apple.com/gb/song/right/2",
      ),
    ).toBe("https://music.apple.com/gb/song/right/2");
  });
});

describe("enrichSecondaryLink", () => {
  test("unwraps a hit to the URL", async () => {
    fetchItem.mockResolvedValue(item());
    search.mockResolvedValue(hit("https://music.apple.com/gb/album/blue-lines/456"));
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

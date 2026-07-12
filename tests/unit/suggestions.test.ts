import { describe, expect, mock, spyOn, test, afterEach, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import * as musicbrainz from "../../server/musicbrainz";
import { db } from "../../server/db/index";
import { artists, itemSuggestions, musicItems } from "../../server/db/schema";
import { normalize } from "../../server/utils";
import {
  fetchAndStoreSuggestion,
  findPendingSuggestionForItem,
  ensureSuggestionsForToListenArtists,
  __clearSuggestionSweepBackoff,
} from "../../server/suggestions";

async function createArtistWithItem(
  artistName: string,
  title: string,
  listenStatus: "to-listen" | "listened" = "to-listen",
): Promise<{ artistId: number; itemId: number }> {
  const [artist] = await db
    .insert(artists)
    .values({ name: artistName, normalizedName: normalize(artistName) })
    .onConflictDoNothing()
    .returning({ id: artists.id });
  const artistId =
    artist?.id ??
    (await db
      .select({ id: artists.id })
      .from(artists)
      .where(eq(artists.normalizedName, normalize(artistName)))
      .get())!.id;

  const [item] = await db
    .insert(musicItems)
    .values({ title, normalizedTitle: normalize(title), artistId, listenStatus })
    .returning({ id: musicItems.id });

  return { artistId, itemId: item.id };
}

const testSuggestion: musicbrainz.SuggestedRelease = {
  title: "Tri Repetae",
  itemType: "album",
  year: 1995,
  musicbrainzReleaseId: "mb-release-uuid",
};

describe("fetchAndStoreSuggestion", () => {
  afterEach(() => {
    mock.restore();
  });

  test("does nothing when item has no artist_name", async () => {
    const mbSpy = spyOn(musicbrainz, "findSuggestedRelease");

    const stored = await fetchAndStoreSuggestion({
      id: 1,
      artist_name: null,
      year: null,
      musicbrainz_artist_id: null,
    });

    expect(stored).toBe(false);
    expect(mbSpy).not.toHaveBeenCalled();
  });

  test("does nothing when findSuggestedRelease returns null", async () => {
    spyOn(musicbrainz, "findSuggestedRelease").mockResolvedValueOnce(null);
    const { itemId } = await createArtistWithItem("Nothing Found FM", "Static");

    const stored = await fetchAndStoreSuggestion({
      id: itemId,
      artist_name: "Nothing Found FM",
      year: 1994,
      musicbrainz_artist_id: null,
    });

    expect(stored).toBe(false);
  });

  test("stores a pending suggestion for the item's artist", async () => {
    spyOn(musicbrainz, "findSuggestedRelease").mockResolvedValueOnce(testSuggestion);
    const { itemId } = await createArtistWithItem("Autechre Store Test", "Amber");

    const stored = await fetchAndStoreSuggestion({
      id: itemId,
      artist_name: "Autechre Store Test",
      year: 1994,
      musicbrainz_artist_id: null,
    });

    expect(stored).toBe(true);
    const row = await db
      .select()
      .from(itemSuggestions)
      .where(eq(itemSuggestions.sourceItemId, itemId))
      .get();
    expect(row?.title).toBe("Tri Repetae");
    expect(row?.status).toBe("pending");
    expect(row?.artistName).toBe("Autechre Store Test");
  });

  test("skips the lookup when the artist already has a pending suggestion", async () => {
    const mbSpy = spyOn(musicbrainz, "findSuggestedRelease").mockResolvedValue(testSuggestion);
    const { itemId } = await createArtistWithItem("Dedupe Test Band", "First Album");

    const first = await fetchAndStoreSuggestion({
      id: itemId,
      artist_name: "Dedupe Test Band",
      year: null,
      musicbrainz_artist_id: null,
    });
    const second = await fetchAndStoreSuggestion({
      id: itemId,
      artist_name: "Dedupe Test Band",
      year: null,
      musicbrainz_artist_id: null,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(mbSpy).toHaveBeenCalledTimes(1);
  });

  test("excludes previously suggested (dismissed) titles from the next lookup", async () => {
    const mbSpy = spyOn(musicbrainz, "findSuggestedRelease").mockResolvedValue(testSuggestion);
    const { itemId } = await createArtistWithItem("Dismiss Exclude Band", "Debut");

    await fetchAndStoreSuggestion({
      id: itemId,
      artist_name: "Dismiss Exclude Band",
      year: null,
      musicbrainz_artist_id: null,
    });
    await db
      .update(itemSuggestions)
      .set({ status: "dismissed" })
      .where(eq(itemSuggestions.sourceItemId, itemId));

    await fetchAndStoreSuggestion({
      id: itemId,
      artist_name: "Dismiss Exclude Band",
      year: null,
      musicbrainz_artist_id: null,
    });

    expect(mbSpy).toHaveBeenCalledTimes(2);
    const secondCall = mbSpy.mock.calls[1][0];
    expect(secondCall.trackedTitles.has("tri repetae")).toBe(true);
  });
});

describe("findPendingSuggestionForItem", () => {
  afterEach(() => {
    mock.restore();
  });

  test("returns the suggestion keyed to the item itself", async () => {
    spyOn(musicbrainz, "findSuggestedRelease").mockResolvedValueOnce(testSuggestion);
    const { itemId } = await createArtistWithItem("Own Suggestion Band", "Own Album");
    await fetchAndStoreSuggestion({
      id: itemId,
      artist_name: "Own Suggestion Band",
      year: null,
      musicbrainz_artist_id: null,
    });

    const found = await findPendingSuggestionForItem(itemId);
    expect(found?.title).toBe("Tri Repetae");
    expect(found?.sourceItemId).toBe(itemId);
  });

  test("falls back to the artist's pending suggestion for a sibling item", async () => {
    spyOn(musicbrainz, "findSuggestedRelease").mockResolvedValueOnce(testSuggestion);
    const { artistId, itemId } = await createArtistWithItem("Fallback Band", "Album One");
    // A second item by the same artist with no suggestion of its own — e.g.
    // one created before the prefetch existed.
    const [sibling] = await db
      .insert(musicItems)
      .values({ title: "Album Two", normalizedTitle: normalize("Album Two"), artistId })
      .returning({ id: musicItems.id });

    await fetchAndStoreSuggestion({
      id: itemId,
      artist_name: "Fallback Band",
      year: null,
      musicbrainz_artist_id: null,
    });

    const found = await findPendingSuggestionForItem(sibling.id);
    expect(found?.title).toBe("Tri Repetae");
  });

  test("returns null when the artist has no pending suggestion", async () => {
    const { itemId } = await createArtistWithItem("No Suggestion Band", "Silent Album");
    const found = await findPendingSuggestionForItem(itemId);
    expect(found).toBeNull();
  });
});

describe("ensureSuggestionsForToListenArtists", () => {
  beforeEach(() => {
    __clearSuggestionSweepBackoff();
    delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
    process.env.OTB_SUGGESTION_SWEEP_THROTTLE_MS = "0";
  });

  afterEach(() => {
    mock.restore();
    delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
    delete process.env.OTB_SUGGESTION_SWEEP_THROTTLE_MS;
  });

  test("prefetches a suggestion for a to-listen artist with none pending", async () => {
    // Give artists from earlier tests pending suggestions so the sweep only
    // looks at the artist created here.
    const uncoveredName = `Sweep Band ${Date.now()}`;
    const mbSpy = spyOn(musicbrainz, "findSuggestedRelease").mockResolvedValue(testSuggestion);
    const { itemId } = await createArtistWithItem(uncoveredName, "Sweep Album");

    await ensureSuggestionsForToListenArtists();

    const sweptCall = mbSpy.mock.calls.find((call) => call[0].artistName === uncoveredName);
    expect(sweptCall).toBeDefined();
    const row = await db
      .select()
      .from(itemSuggestions)
      .where(eq(itemSuggestions.sourceItemId, itemId))
      .get();
    expect(row?.status).toBe("pending");
  });

  test("skips artists whose items are all listened", async () => {
    const listenedName = `Listened Band ${Date.now()}`;
    const mbSpy = spyOn(musicbrainz, "findSuggestedRelease").mockResolvedValue(testSuggestion);
    await createArtistWithItem(listenedName, "Done Album", "listened");

    await ensureSuggestionsForToListenArtists();

    const call = mbSpy.mock.calls.find((c) => c[0].artistName === listenedName);
    expect(call).toBeUndefined();
  });

  test("backs off artists whose lookup found nothing", async () => {
    const emptyName = `Empty Band ${Date.now()}`;
    const mbSpy = spyOn(musicbrainz, "findSuggestedRelease").mockResolvedValue(null);
    await createArtistWithItem(emptyName, "Only Album");

    await ensureSuggestionsForToListenArtists();
    const callsAfterFirst = mbSpy.mock.calls.filter((c) => c[0].artistName === emptyName).length;
    await ensureSuggestionsForToListenArtists();
    const callsAfterSecond = mbSpy.mock.calls.filter((c) => c[0].artistName === emptyName).length;

    expect(callsAfterFirst).toBe(1);
    expect(callsAfterSecond).toBe(1);
  });

  test("no-ops under OTB_DISABLE_EXTERNAL_LOOKUPS", async () => {
    process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";
    const mbSpy = spyOn(musicbrainz, "findSuggestedRelease");
    await createArtistWithItem(`Disabled Band ${Date.now()}`, "Hidden Album");

    await ensureSuggestionsForToListenArtists();

    expect(mbSpy).not.toHaveBeenCalled();
  });
});

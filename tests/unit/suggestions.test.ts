import { describe, expect, mock, spyOn, test, afterEach, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import * as musicbrainz from "../../server/musicbrainz";
import { db } from "../../server/db/index";
import { artists, itemSuggestions, musicItems } from "../../server/db/schema";
import { normalize } from "../../server/utils";
import {
  fetchAndStoreSuggestion,
  findPendingSuggestionForItem,
  ensureSuggestionForItemNow,
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
  beforeEach(() => {
    __clearSuggestionSweepBackoff();
  });

  afterEach(() => {
    mock.restore();
  });

  test("skips when item has no artist_name", async () => {
    const mbSpy = spyOn(musicbrainz, "findSuggestedRelease");

    const outcome = await fetchAndStoreSuggestion({
      id: 1,
      artist_name: null,
      year: null,
      musicbrainz_artist_id: null,
    });

    expect(outcome).toBe("skipped");
    expect(mbSpy).not.toHaveBeenCalled();
  });

  test("reports no-candidates when findSuggestedRelease returns null, then backs off", async () => {
    const mbSpy = spyOn(musicbrainz, "findSuggestedRelease").mockResolvedValue(null);
    const { itemId } = await createArtistWithItem("Nothing Found FM", "Static");

    const first = await fetchAndStoreSuggestion({
      id: itemId,
      artist_name: "Nothing Found FM",
      year: 1994,
      musicbrainz_artist_id: null,
    });
    const second = await fetchAndStoreSuggestion({
      id: itemId,
      artist_name: "Nothing Found FM",
      year: 1994,
      musicbrainz_artist_id: null,
    });

    expect(first).toBe("no-candidates");
    expect(second).toBe("skipped");
    expect(mbSpy).toHaveBeenCalledTimes(1);
  });

  test("reports error without backing off when the lookup throws", async () => {
    const mbSpy = spyOn(musicbrainz, "findSuggestedRelease").mockRejectedValue(
      new Error("MusicBrainz artist search returned 503"),
    );
    const { itemId } = await createArtistWithItem("Rate Limited Band", "Throttled");

    const first = await fetchAndStoreSuggestion({
      id: itemId,
      artist_name: "Rate Limited Band",
      year: null,
      musicbrainz_artist_id: null,
    });
    // A transient failure must not suppress the artist for 24h — the next
    // attempt retries the lookup.
    const second = await fetchAndStoreSuggestion({
      id: itemId,
      artist_name: "Rate Limited Band",
      year: null,
      musicbrainz_artist_id: null,
    });

    expect(first).toBe("error");
    expect(second).toBe("error");
    expect(mbSpy).toHaveBeenCalledTimes(2);
  });

  test("stores a pending suggestion for the item's artist", async () => {
    spyOn(musicbrainz, "findSuggestedRelease").mockResolvedValueOnce(testSuggestion);
    const { itemId } = await createArtistWithItem("Autechre Store Test", "Amber");

    const outcome = await fetchAndStoreSuggestion({
      id: itemId,
      artist_name: "Autechre Store Test",
      year: 1994,
      musicbrainz_artist_id: null,
    });

    expect(outcome).toBe("stored");
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

    expect(first).toBe("stored");
    expect(second).toBe("already-pending");
    expect(mbSpy).toHaveBeenCalledTimes(1);
  });

  test("concurrent calls for the same artist share one lookup and store one row", async () => {
    // The background prefetch fired at creation and the on-demand lookup at
    // state-change time can overlap — they must not both insert.
    const mbSpy = spyOn(musicbrainz, "findSuggestedRelease").mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(testSuggestion), 30)),
    );
    const { itemId } = await createArtistWithItem("Concurrent Band", "Race Album");
    const summary = {
      id: itemId,
      artist_name: "Concurrent Band",
      year: null,
      musicbrainz_artist_id: null,
    };

    const [first, second] = await Promise.all([
      fetchAndStoreSuggestion(summary),
      fetchAndStoreSuggestion(summary),
    ]);

    expect(first).toBe("stored");
    expect(second).toBe("stored");
    expect(mbSpy).toHaveBeenCalledTimes(1);
    const rows = await db
      .select()
      .from(itemSuggestions)
      .where(eq(itemSuggestions.sourceItemId, itemId));
    expect(rows.length).toBe(1);
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

  test("excludes titles from the whole library, not just the item's artist", async () => {
    const mbSpy = spyOn(musicbrainz, "findSuggestedRelease").mockResolvedValue(testSuggestion);
    await createArtistWithItem("Other Library Artist", "Crosslib Album", "listened");
    const { itemId } = await createArtistWithItem("Library Wide Band", "Own Album");

    await fetchAndStoreSuggestion({
      id: itemId,
      artist_name: "Library Wide Band",
      year: null,
      musicbrainz_artist_id: null,
    });

    const call = mbSpy.mock.calls[0][0];
    expect(call.trackedTitles.has("own album")).toBe(true);
    // A listened item by a different artist still counts as "in the library".
    expect(call.trackedTitles.has("crosslib album")).toBe(true);
  });

  test("passes the stored release length preference to the lookup", async () => {
    const { setReleaseLengthPreference } = await import("../../server/settings");
    await setReleaseLengthPreference("shorter");
    const mbSpy = spyOn(musicbrainz, "findSuggestedRelease").mockResolvedValue(testSuggestion);
    const { itemId } = await createArtistWithItem("Length Pref Band", "Length Album");

    await fetchAndStoreSuggestion({
      id: itemId,
      artist_name: "Length Pref Band",
      year: null,
      musicbrainz_artist_id: null,
    });

    expect(mbSpy.mock.calls[0][0].lengthPreference).toBe("shorter");
    await setReleaseLengthPreference("longer");
  });
});

describe("findPendingSuggestionForItem", () => {
  beforeEach(() => {
    __clearSuggestionSweepBackoff();
  });

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

describe("ensureSuggestionForItemNow", () => {
  beforeEach(() => {
    __clearSuggestionSweepBackoff();
    delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
  });

  afterEach(() => {
    mock.restore();
    delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
  });

  test("returns the prefetched suggestion without a live lookup", async () => {
    const mbSpy = spyOn(musicbrainz, "findSuggestedRelease").mockResolvedValueOnce(testSuggestion);
    const { itemId } = await createArtistWithItem("Prefetched Now Band", "Ready Album");
    await fetchAndStoreSuggestion({
      id: itemId,
      artist_name: "Prefetched Now Band",
      year: null,
      musicbrainz_artist_id: null,
    });
    mbSpy.mockClear();

    const found = await ensureSuggestionForItemNow(itemId);

    expect(found?.title).toBe("Tri Repetae");
    expect(mbSpy).not.toHaveBeenCalled();
  });

  test("looks up a suggestion on demand when nothing was prefetched", async () => {
    // The exact race the prompt used to lose: item marked listened before the
    // background prefetch stored anything.
    const mbSpy = spyOn(musicbrainz, "findSuggestedRelease").mockResolvedValueOnce(testSuggestion);
    const { itemId } = await createArtistWithItem("On Demand Band", "Fresh Album");

    const found = await ensureSuggestionForItemNow(itemId);

    expect(mbSpy).toHaveBeenCalledTimes(1);
    expect(found?.title).toBe("Tri Repetae");
    expect(found?.status).toBe("pending");
  });

  test("returns null when the lookup exceeds the timeout, but stores in background", async () => {
    let resolveLookup: (value: musicbrainz.SuggestedRelease) => void;
    spyOn(musicbrainz, "findSuggestedRelease").mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLookup = resolve;
      }),
    );
    const { itemId } = await createArtistWithItem("Slow Lookup Band", "Slow Album");

    const found = await ensureSuggestionForItemNow(itemId, 50);
    expect(found).toBeNull();

    // The in-flight lookup completes later and stores the suggestion for
    // the next state change.
    resolveLookup!(testSuggestion);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const later = await findPendingSuggestionForItem(itemId);
    expect(later?.title).toBe("Tri Repetae");
  });

  test("does not perform a live lookup under OTB_DISABLE_EXTERNAL_LOOKUPS", async () => {
    process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";
    const mbSpy = spyOn(musicbrainz, "findSuggestedRelease");
    const { itemId } = await createArtistWithItem("Disabled Now Band", "Quiet Album");

    const found = await ensureSuggestionForItemNow(itemId);

    expect(found).toBeNull();
    expect(mbSpy).not.toHaveBeenCalled();
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

  test("retries artists whose lookup errored", async () => {
    const flakyName = `Flaky Band ${Date.now()}`;
    const mbSpy = spyOn(musicbrainz, "findSuggestedRelease").mockRejectedValue(
      new Error("MusicBrainz artist lookup returned 503"),
    );
    await createArtistWithItem(flakyName, "Retry Album");

    await ensureSuggestionsForToListenArtists();
    await ensureSuggestionsForToListenArtists();

    const calls = mbSpy.mock.calls.filter((c) => c[0].artistName === flakyName).length;
    expect(calls).toBe(2);
  });

  test("no-ops under OTB_DISABLE_EXTERNAL_LOOKUPS", async () => {
    process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";
    const mbSpy = spyOn(musicbrainz, "findSuggestedRelease");
    await createArtistWithItem(`Disabled Band ${Date.now()}`, "Hidden Album");

    await ensureSuggestionsForToListenArtists();

    expect(mbSpy).not.toHaveBeenCalled();
  });
});

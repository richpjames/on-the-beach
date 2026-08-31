import { describe, expect, mock, spyOn, test, afterEach, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import * as musicbrainz from "../../server/musicbrainz";
import { db } from "../../server/db/index";
import { artists, itemSuggestions, musicItems } from "../../server/db/schema";
import { VARIOUS_ARTISTS_MBID } from "../../server/artist-identity";
import { normalize } from "../../server/utils";
import {
  backfillSuggestionReleaseGroups,
  fetchAndStoreSuggestion,
  findPendingSuggestionsForItem,
  ensureSuggestionsForItemNow,
  ensureSuggestionsForToListenArtists,
  SUGGESTION_TARGET,
  __clearSuggestionSweepBackoff,
} from "../../server/suggestions";

async function createArtistWithItem(
  artistName: string,
  title: string,
  listenStatus: "to-listen" | "listened" = "to-listen",
  year: number | null = null,
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
    .values({ title, normalizedTitle: normalize(title), artistId, listenStatus, year })
    .returning({ id: musicItems.id });

  return { artistId, itemId: item.id };
}

/** Insert a pending suggestion row directly, as the prefetch would have. */
async function seedSuggestion(
  sourceItemId: number,
  artistName: string,
  {
    releaseId,
    groupId,
    title,
    year,
  }: {
    releaseId: string | null;
    groupId?: string | null;
    title?: string;
    year?: number | null;
  },
) {
  return db
    .insert(itemSuggestions)
    .values({
      sourceItemId,
      title: title ?? `Seeded ${sourceItemId}`,
      artistName,
      itemType: "album",
      year: year ?? null,
      musicbrainzReleaseId: releaseId,
      musicbrainzReleaseGroupId: groupId ?? null,
      status: "pending",
    })
    .returning();
}

const testSuggestion: musicbrainz.SuggestedRelease = {
  title: "Tri Repetae",
  itemType: "album",
  year: 1995,
  musicbrainzReleaseId: "mb-release-uuid",
  musicbrainzReleaseGroupId: "mb-release-group-uuid",
};

/** A full set of distinct suggestions, as a healthy lookup returns. */
const testSuggestionSet: musicbrainz.SuggestedRelease[] = [
  testSuggestion,
  {
    title: "Chiastic Slide",
    itemType: "album",
    year: 1997,
    musicbrainzReleaseId: "mb-release-uuid-2",
    musicbrainzReleaseGroupId: "mb-release-group-uuid-2",
  },
  {
    title: "Confield",
    itemType: "album",
    year: 2001,
    musicbrainzReleaseId: "mb-release-uuid-3",
    musicbrainzReleaseGroupId: "mb-release-group-uuid-3",
  },
];

describe("fetchAndStoreSuggestion", () => {
  beforeEach(() => {
    __clearSuggestionSweepBackoff();
  });

  afterEach(() => {
    mock.restore();
  });

  test("skips when item has no artist_name", async () => {
    const mbSpy = spyOn(musicbrainz, "findSuggestedReleases");

    const outcome = await fetchAndStoreSuggestion({
      id: 1,
      artist_name: null,
      year: null,
      musicbrainz_artist_id: null,
    });

    expect(outcome).toBe("skipped");
    expect(mbSpy).not.toHaveBeenCalled();
  });

  test("skips compilations, by name and by MusicBrainz id", async () => {
    const mbSpy = spyOn(musicbrainz, "findSuggestedReleases");

    for (const artistName of ["Various Artists", "various artists", "VA", "V/A", "Various"]) {
      expect(
        await fetchAndStoreSuggestion({
          id: 1,
          artist_name: artistName,
          year: null,
          musicbrainz_artist_id: null,
        }),
      ).toBe("skipped");
    }

    // A compilation credited to something else entirely, caught by its MBID.
    expect(
      await fetchAndStoreSuggestion({
        id: 1,
        artist_name: "Diverse Interpreten",
        year: null,
        musicbrainz_artist_id: VARIOUS_ARTISTS_MBID,
      }),
    ).toBe("skipped");

    expect(mbSpy).not.toHaveBeenCalled();
  });

  test("reports no-candidates when the lookup finds nothing, then backs off", async () => {
    const mbSpy = spyOn(musicbrainz, "findSuggestedReleases").mockResolvedValue([]);
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
    const mbSpy = spyOn(musicbrainz, "findSuggestedReleases").mockRejectedValue(
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
    spyOn(musicbrainz, "findSuggestedReleases").mockResolvedValueOnce([testSuggestion]);
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

  test("asks for and stores a full set, so the prompt can offer a choice", async () => {
    const mbSpy = spyOn(musicbrainz, "findSuggestedReleases").mockResolvedValueOnce(
      testSuggestionSet,
    );
    const { itemId } = await createArtistWithItem("Full Set Band", "First Album");

    const outcome = await fetchAndStoreSuggestion({
      id: itemId,
      artist_name: "Full Set Band",
      year: null,
      musicbrainz_artist_id: null,
    });

    expect(outcome).toBe("stored");
    expect(mbSpy.mock.calls[0][0].limit).toBe(SUGGESTION_TARGET);
    const rows = await db
      .select()
      .from(itemSuggestions)
      .where(eq(itemSuggestions.sourceItemId, itemId));
    expect(rows.map((row) => row.title)).toEqual(["Tri Repetae", "Chiastic Slide", "Confield"]);
    expect(rows.every((row) => row.status === "pending")).toBe(true);
  });

  test("tops the artist up to a full set rather than re-asking for one", async () => {
    const mbSpy = spyOn(musicbrainz, "findSuggestedReleases").mockResolvedValue(
      testSuggestionSet.slice(1),
    );
    const { itemId } = await createArtistWithItem("Top Up Band", "First Album");
    await seedSuggestion(itemId, "Top Up Band", { releaseId: "already-here" });

    const outcome = await fetchAndStoreSuggestion({
      id: itemId,
      artist_name: "Top Up Band",
      year: null,
      musicbrainz_artist_id: null,
    });

    expect(outcome).toBe("stored");
    // One already on file, so only the remaining slots are asked for.
    expect(mbSpy.mock.calls[0][0].limit).toBe(SUGGESTION_TARGET - 1);
    const rows = await db
      .select()
      .from(itemSuggestions)
      .where(eq(itemSuggestions.sourceItemId, itemId));
    expect(rows.length).toBe(SUGGESTION_TARGET);
  });

  test("skips the lookup when the artist already has a full set of suggestions", async () => {
    const mbSpy = spyOn(musicbrainz, "findSuggestedReleases").mockResolvedValue(testSuggestionSet);
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

  test("backs off an artist whose lookup could not fill the set", async () => {
    // Only one suggestible release exists; without a backoff every sweep would
    // spend a MusicBrainz round trip on the two slots it can never fill.
    const mbSpy = spyOn(musicbrainz, "findSuggestedReleases").mockResolvedValue([testSuggestion]);
    const { itemId } = await createArtistWithItem("Short Catalogue Band", "Only Album");
    const summary = {
      id: itemId,
      artist_name: "Short Catalogue Band",
      year: null,
      musicbrainz_artist_id: null,
    };

    expect(await fetchAndStoreSuggestion(summary)).toBe("stored");
    expect(await fetchAndStoreSuggestion(summary)).toBe("skipped");
    expect(mbSpy).toHaveBeenCalledTimes(1);
  });

  test("concurrent calls for the same artist share one lookup and store one row", async () => {
    // The background prefetch fired at creation and the on-demand lookup at
    // state-change time can overlap — they must not both insert.
    const mbSpy = spyOn(musicbrainz, "findSuggestedReleases").mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve([testSuggestion]), 30)),
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
    const mbSpy = spyOn(musicbrainz, "findSuggestedReleases").mockResolvedValue(testSuggestionSet);
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
    const mbSpy = spyOn(musicbrainz, "findSuggestedReleases").mockResolvedValue([testSuggestion]);
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
    const mbSpy = spyOn(musicbrainz, "findSuggestedReleases").mockResolvedValue([testSuggestion]);
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

describe("findPendingSuggestionsForItem", () => {
  beforeEach(() => {
    __clearSuggestionSweepBackoff();
  });

  afterEach(() => {
    mock.restore();
  });

  test("returns the suggestion keyed to the item itself", async () => {
    spyOn(musicbrainz, "findSuggestedReleases").mockResolvedValueOnce([testSuggestion]);
    const { itemId } = await createArtistWithItem("Own Suggestion Band", "Own Album");
    await fetchAndStoreSuggestion({
      id: itemId,
      artist_name: "Own Suggestion Band",
      year: null,
      musicbrainz_artist_id: null,
    });

    const [found] = await findPendingSuggestionsForItem(itemId);
    expect(found?.title).toBe("Tri Repetae");
    expect(found?.sourceItemId).toBe(itemId);
  });

  test("falls back to the artist's pending suggestion for a sibling item", async () => {
    spyOn(musicbrainz, "findSuggestedReleases").mockResolvedValueOnce([testSuggestion]);
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

    const [found] = await findPendingSuggestionsForItem(sibling.id);
    expect(found?.title).toBe("Tri Repetae");
  });

  test("returns nothing when the artist has no pending suggestion", async () => {
    const { itemId } = await createArtistWithItem("No Suggestion Band", "Silent Album");
    const found = await findPendingSuggestionsForItem(itemId);
    expect(found).toEqual([]);
  });

  test("returns the artist's whole pending set, own-item suggestions first", async () => {
    spyOn(musicbrainz, "findSuggestedReleases").mockResolvedValueOnce(testSuggestionSet);
    const { artistId, itemId } = await createArtistWithItem("Whole Set Band", "Album One");
    const [sibling] = await db
      .insert(musicItems)
      .values({ title: "Album Two", normalizedTitle: normalize("Album Two"), artistId })
      .returning({ id: musicItems.id });
    // Keyed to the sibling, so it must lead when the sibling is the source.
    await seedSuggestion(sibling.id, "Whole Set Band", { releaseId: "sibling-release" });

    await fetchAndStoreSuggestion({
      id: itemId,
      artist_name: "Whole Set Band",
      year: null,
      musicbrainz_artist_id: null,
    });

    const found = await findPendingSuggestionsForItem(sibling.id);
    expect(found.length).toBe(SUGGESTION_TARGET);
    expect(found[0].sourceItemId).toBe(sibling.id);
    expect(found.map((row) => row.title)).toContain("Tri Repetae");
  });

  test("leads with the suggestion closest to the item's own release year", async () => {
    // The artist's pending rows were fetched against a sibling from a
    // different era, so their stored order says nothing about the item being
    // marked listened.
    const name = `Proximity Band ${Date.now()}`;
    const { artistId, itemId } = await createArtistWithItem(name, "Early Album", "to-listen", 1972);
    const [sibling] = await db
      .insert(musicItems)
      .values({
        title: "Comeback Album",
        normalizedTitle: normalize("Comeback Album"),
        artistId,
        year: 1989,
      })
      .returning({ id: musicItems.id });
    await seedSuggestion(sibling.id, name, {
      releaseId: "late-release",
      title: "Late Comeback",
      year: 1991,
    });
    await seedSuggestion(sibling.id, name, {
      releaseId: "early-release",
      title: "Early Follow-Up",
      year: 1973,
    });

    const found = await findPendingSuggestionsForItem(itemId);

    expect(found.map((row) => row.title)).toEqual(["Early Follow-Up", "Late Comeback"]);
  });

  test("surfaces undated suggestions behind dated ones", async () => {
    const name = `Undated Suggestion Band ${Date.now()}`;
    const { itemId } = await createArtistWithItem(name, "Dated Album", "to-listen", 1980);
    await seedSuggestion(itemId, name, { releaseId: "undated-release", title: "No Date At All" });
    await seedSuggestion(itemId, name, {
      releaseId: "far-release",
      title: "Two Decades Later",
      year: 2001,
    });

    const found = await findPendingSuggestionsForItem(itemId);

    expect(found.map((row) => row.title)).toEqual(["Two Decades Later", "No Date At All"]);
  });

  test("caps the set at the requested limit", async () => {
    spyOn(musicbrainz, "findSuggestedReleases").mockResolvedValueOnce(testSuggestionSet);
    const { itemId } = await createArtistWithItem("Capped Band", "Album One");
    await fetchAndStoreSuggestion({
      id: itemId,
      artist_name: "Capped Band",
      year: null,
      musicbrainz_artist_id: null,
    });

    expect((await findPendingSuggestionsForItem(itemId, 2)).length).toBe(2);
  });
});

describe("ensureSuggestionsForItemNow", () => {
  beforeEach(() => {
    __clearSuggestionSweepBackoff();
    delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
  });

  afterEach(() => {
    mock.restore();
    delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
  });

  test("returns the prefetched suggestions without a live lookup", async () => {
    const mbSpy = spyOn(musicbrainz, "findSuggestedReleases").mockResolvedValueOnce([
      testSuggestion,
    ]);
    const { itemId } = await createArtistWithItem("Prefetched Now Band", "Ready Album");
    await fetchAndStoreSuggestion({
      id: itemId,
      artist_name: "Prefetched Now Band",
      year: null,
      musicbrainz_artist_id: null,
    });
    mbSpy.mockClear();

    const found = await ensureSuggestionsForItemNow(itemId);

    expect(found.map((row) => row.title)).toEqual(["Tri Repetae"]);
    expect(mbSpy).not.toHaveBeenCalled();
  });

  test("looks up suggestions on demand when nothing was prefetched", async () => {
    // The exact race the prompt used to lose: item marked listened before the
    // background prefetch stored anything.
    const mbSpy = spyOn(musicbrainz, "findSuggestedReleases").mockResolvedValueOnce([
      testSuggestion,
    ]);
    const { itemId } = await createArtistWithItem("On Demand Band", "Fresh Album");

    const found = await ensureSuggestionsForItemNow(itemId);

    expect(mbSpy).toHaveBeenCalledTimes(1);
    expect(found[0]?.title).toBe("Tri Repetae");
    expect(found[0]?.status).toBe("pending");
  });

  test("returns nothing when the lookup exceeds the timeout, but stores in background", async () => {
    let resolveLookup: (value: musicbrainz.SuggestedRelease[]) => void;
    spyOn(musicbrainz, "findSuggestedReleases").mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLookup = resolve;
      }),
    );
    const { itemId } = await createArtistWithItem("Slow Lookup Band", "Slow Album");

    const found = await ensureSuggestionsForItemNow(itemId, 50);
    expect(found).toEqual([]);

    // The in-flight lookup completes later and stores the suggestion for
    // the next state change.
    resolveLookup!([testSuggestion]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [later] = await findPendingSuggestionsForItem(itemId);
    expect(later?.title).toBe("Tri Repetae");
  });

  test("never looks up or surfaces suggestions for a compilation", async () => {
    const mbSpy = spyOn(musicbrainz, "findSuggestedReleases").mockResolvedValue([testSuggestion]);
    const { itemId } = await createArtistWithItem("Various Artists", "Now That's What I Call 42");
    // …even if a row was stored back when compilations were looked up.
    await seedSuggestion(itemId, "Various Artists", { releaseId: "legacy-release" });

    const found = await ensureSuggestionsForItemNow(itemId);

    expect(found).toEqual([]);
    expect(mbSpy).not.toHaveBeenCalled();
  });

  test("does not perform a live lookup under OTB_DISABLE_EXTERNAL_LOOKUPS", async () => {
    process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";
    const mbSpy = spyOn(musicbrainz, "findSuggestedReleases");
    const { itemId } = await createArtistWithItem("Disabled Now Band", "Quiet Album");

    const found = await ensureSuggestionsForItemNow(itemId);

    expect(found).toEqual([]);
    expect(mbSpy).not.toHaveBeenCalled();
  });
});

describe("ensureSuggestionsForToListenArtists", () => {
  beforeEach(() => {
    __clearSuggestionSweepBackoff();
    delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
    process.env.OTB_SUGGESTION_SWEEP_THROTTLE_MS = "0";
    // The sweep opens with the release-group backfill; stub it so rows left by
    // other tests can't send these cases to the real MusicBrainz.
    spyOn(musicbrainz, "fetchReleaseGroupIdForRelease").mockResolvedValue([]);
  });

  afterEach(() => {
    mock.restore();
    delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
    delete process.env.OTB_SUGGESTION_SWEEP_THROTTLE_MS;
  });

  test("prefetches a suggestion for a to-listen artist with none pending", async () => {
    const uncoveredName = `Sweep Band ${Date.now()}`;
    const mbSpy = spyOn(musicbrainz, "findSuggestedReleases").mockResolvedValue([testSuggestion]);
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
    const mbSpy = spyOn(musicbrainz, "findSuggestedReleases").mockResolvedValue([testSuggestion]);
    await createArtistWithItem(listenedName, "Done Album", "listened");

    await ensureSuggestionsForToListenArtists();

    const call = mbSpy.mock.calls.find((c) => c[0].artistName === listenedName);
    expect(call).toBeUndefined();
  });

  test("backs off artists whose lookup found nothing", async () => {
    const emptyName = `Empty Band ${Date.now()}`;
    const mbSpy = spyOn(musicbrainz, "findSuggestedReleases").mockResolvedValue([]);
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
    const mbSpy = spyOn(musicbrainz, "findSuggestedReleases").mockRejectedValue(
      new Error("MusicBrainz artist lookup returned 503"),
    );
    await createArtistWithItem(flakyName, "Retry Album");

    await ensureSuggestionsForToListenArtists();
    await ensureSuggestionsForToListenArtists();

    const calls = mbSpy.mock.calls.filter((c) => c[0].artistName === flakyName).length;
    expect(calls).toBe(2);
  });

  test("skips compilations", async () => {
    const mbSpy = spyOn(musicbrainz, "findSuggestedReleases").mockResolvedValue([testSuggestion]);
    await createArtistWithItem("Various Artists", `Sweep Compilation ${Date.now()}`);

    await ensureSuggestionsForToListenArtists();

    const call = mbSpy.mock.calls.find((c) => c[0].artistName === "Various Artists");
    expect(call).toBeUndefined();
  });

  test("no-ops under OTB_DISABLE_EXTERNAL_LOOKUPS", async () => {
    process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";
    const mbSpy = spyOn(musicbrainz, "findSuggestedReleases");
    await createArtistWithItem(`Disabled Band ${Date.now()}`, "Hidden Album");

    await ensureSuggestionsForToListenArtists();

    expect(mbSpy).not.toHaveBeenCalled();
  });

  test("backfills release-group ids for suggestions stored without one", async () => {
    const name = `Backfill Sweep Band ${Date.now()}`;
    spyOn(musicbrainz, "findSuggestedReleases").mockResolvedValue([]);
    const groupSpy = spyOn(musicbrainz, "fetchReleaseGroupIdForRelease").mockResolvedValue(
      "swept-rg",
    );
    const { itemId } = await createArtistWithItem(name, "Backfill Sweep Album");
    const [row] = await seedSuggestion(itemId, name, { releaseId: "swept-release" });

    await ensureSuggestionsForToListenArtists();

    expect(groupSpy).toHaveBeenCalled();
    const updated = await db
      .select()
      .from(itemSuggestions)
      .where(eq(itemSuggestions.id, row.id))
      .get();
    expect(updated?.musicbrainzReleaseGroupId).toBe("swept-rg");
  });
});

describe("backfillSuggestionReleaseGroups", () => {
  beforeEach(() => {
    delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
  });

  afterEach(() => {
    mock.restore();
    delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
  });

  test("skips suggestions that already carry a release-group id", async () => {
    const name = `Already Grouped ${Date.now()}`;
    const groupSpy = spyOn(musicbrainz, "fetchReleaseGroupIdForRelease").mockResolvedValue(
      "rg-new",
    );
    const { itemId } = await createArtistWithItem(name, "Grouped Album");
    const [row] = await seedSuggestion(itemId, name, {
      releaseId: "release-uuid",
      groupId: "rg-existing",
    });

    await backfillSuggestionReleaseGroups();

    expect(groupSpy.mock.calls.some((call) => call[0] === "release-uuid")).toBe(false);
    const updated = await db
      .select()
      .from(itemSuggestions)
      .where(eq(itemSuggestions.id, row.id))
      .get();
    expect(updated?.musicbrainzReleaseGroupId).toBe("rg-existing");
  });

  test("leaves the row untouched when the lookup fails, so the next sweep retries", async () => {
    const name = `Backfill Failure ${Date.now()}`;
    spyOn(musicbrainz, "fetchReleaseGroupIdForRelease").mockRejectedValue(
      new Error("MusicBrainz release lookup returned 503"),
    );
    const { itemId } = await createArtistWithItem(name, "Flaky Album");
    const [row] = await seedSuggestion(itemId, name, { releaseId: "flaky-release" });

    const filled = await backfillSuggestionReleaseGroups();

    expect(filled).toBe(0);
    const updated = await db
      .select()
      .from(itemSuggestions)
      .where(eq(itemSuggestions.id, row.id))
      .get();
    expect(updated?.musicbrainzReleaseGroupId).toBeNull();
  });

  test("no-ops under OTB_DISABLE_EXTERNAL_LOOKUPS", async () => {
    process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";
    const groupSpy = spyOn(musicbrainz, "fetchReleaseGroupIdForRelease");

    expect(await backfillSuggestionReleaseGroups()).toBe(0);
    expect(groupSpy).not.toHaveBeenCalled();
  });
});

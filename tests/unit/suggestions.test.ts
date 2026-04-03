import { describe, expect, mock, spyOn, test, afterEach } from "bun:test";
import * as musicbrainz from "../../server/musicbrainz";

describe("fetchAndStoreSuggestion", () => {
  afterEach(() => {
    mock.restore();
  });

  test("does nothing when item has no artist_name", async () => {
    const { fetchAndStoreSuggestion } = await import("../../server/suggestions");
    const mbSpy = spyOn(musicbrainz, "findSuggestedRelease");

    await fetchAndStoreSuggestion({
      id: 1,
      artist_name: null,
      year: null,
      musicbrainz_artist_id: null,
    });

    expect(mbSpy).not.toHaveBeenCalled();
  });

  test("does nothing when findSuggestedRelease returns null", async () => {
    const { fetchAndStoreSuggestion } = await import("../../server/suggestions");
    spyOn(musicbrainz, "findSuggestedRelease").mockResolvedValueOnce(null);

    // Should not throw
    await fetchAndStoreSuggestion({
      id: 1,
      artist_name: "Autechre",
      year: 1994,
      musicbrainz_artist_id: null,
    });
  });
});

import { describe, expect, test } from "bun:test";
import { catalogueMatchUpdates } from "../../src/ui/logic/catalogue-match";

// What the edit form sends for the catalogue-match fields. The promises under
// test are the ones the form's comment makes: paste to correct, empty both to
// clear the whole match, and only a real change is sent.

const MBID = "2f59e6b5-6c3f-4a2b-b47f-9b0f1d3e4f5a";

function item(overrides: Partial<Record<string, number | string | null>> = {}) {
  return {
    discogs_release_id: null,
    discogs_master_id: null,
    musicbrainz_release_id: null,
    musicbrainz_release_group_id: null,
    ...overrides,
  } as Parameters<typeof catalogueMatchUpdates>[2];
}

describe("catalogueMatchUpdates", () => {
  test("an unchanged match sends nothing", () => {
    const updates = catalogueMatchUpdates(
      "4419535",
      MBID,
      item({ discogs_release_id: 4419535, musicbrainz_release_id: MBID }),
    );
    expect(updates).toEqual({});
  });

  test("pasting a release URL corrects that id and only that id", () => {
    const updates = catalogueMatchUpdates(
      "https://www.discogs.com/release/123456",
      MBID,
      item({ discogs_release_id: 999999, musicbrainz_release_id: MBID }),
    );
    expect(updates).toEqual({ discogsReleaseId: 123456 });
  });

  test("pasting a master URL sets the master, leaving the release id alone", () => {
    const updates = catalogueMatchUpdates(
      "https://www.discogs.com/master/706722",
      "",
      item({ discogs_release_id: 111111 }),
    );
    expect(updates).toEqual({ discogsMasterId: 706722 });
  });

  test("emptying both fields clears the whole match — master and group included", () => {
    // A scan-resolved row carries ids the form doesn't show; leaving them
    // behind would keep the row "matched" with nothing visible to show for it.
    const updates = catalogueMatchUpdates(
      "",
      "",
      item({
        discogs_release_id: 4419535,
        discogs_master_id: 706722,
        musicbrainz_release_id: MBID,
        musicbrainz_release_group_id: "group-1",
      }),
    );
    expect(updates).toEqual({
      discogsReleaseId: null,
      discogsMasterId: null,
      musicbrainzReleaseId: null,
      musicbrainzReleaseGroupId: null,
    });
  });

  test("empty fields on a row with no match send nothing", () => {
    expect(catalogueMatchUpdates("", "", item())).toEqual({});
  });

  test("emptying one field while the other is untouched sends nothing for either", () => {
    // The contract is "empty both to clear" — a lone emptied field isn't a
    // partial clear, and must not silently drop just that id.
    const updates = catalogueMatchUpdates(
      "",
      MBID,
      item({
        discogs_release_id: 4419535,
        musicbrainz_release_id: MBID,
      }),
    );
    expect(updates).toEqual({});
  });

  test("an unparsable reference is an error, not a guess", () => {
    expect(catalogueMatchUpdates("salsa bestial", "", item())).toHaveProperty("error");
    expect(catalogueMatchUpdates("", "mb-release-1", item())).toHaveProperty("error");
  });
});

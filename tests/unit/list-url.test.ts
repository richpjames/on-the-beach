import { describe, expect, test } from "bun:test";
import {
  buildListHref,
  buildListSearch,
  buildReleaseHref,
  buildStackPath,
  defaultListViewState,
  isDefaultListViewState,
  parseListViewState,
  sanitizeListHref,
  slugifyStackName,
  stackIdFromListPath,
  type ListViewState,
} from "../../src/ui/logic/list-url";

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

describe("defaultListViewState", () => {
  test("home defaults to the to-listen queue", () => {
    expect(defaultListViewState(null)).toEqual({
      filter: "to-listen",
      search: "",
      sort: "date-added",
      sortDirection: "desc",
      pick: null,
    });
  });

  test("stack pages default to showing everything in the stack", () => {
    expect(defaultListViewState(7).filter).toBe("all");
  });
});

describe("parseListViewState", () => {
  test("reads every control out of the query string", () => {
    expect(
      parseListViewState(
        params("filter=listened&q=aphex&sort=star-rating&dir=asc&pick=3-4.5"),
        null,
      ),
    ).toEqual({
      filter: "listened",
      search: "aphex",
      sort: "star-rating",
      sortDirection: "asc",
      pick: { min: 3, max: 4.5 },
    });
  });

  test("reads a single-value pick range", () => {
    expect(parseListViewState(params("pick=4"), null).pick).toEqual({ min: 4, max: 4 });
  });

  test("ignores a junk pick range", () => {
    expect(parseListViewState(params("pick=nonsense"), null).pick).toBeNull();
    expect(parseListViewState(params(""), null).pick).toBeNull();
  });

  test("falls back to defaults for unknown values", () => {
    expect(parseListViewState(params("filter=nope&sort=bogus&dir=sideways"), null)).toEqual(
      defaultListViewState(null),
    );
  });

  test("falls back to the stack default filter on stack pages", () => {
    expect(parseListViewState(params(""), 3).filter).toBe("all");
  });
});

describe("buildListSearch", () => {
  const state: ListViewState = {
    filter: "listened",
    search: "  boards of canada  ",
    sort: "artist-name",
    sortDirection: "asc",
    pick: null,
  };

  test("serialises non-default controls and trims the search", () => {
    expect(buildListSearch(state, null)).toBe(
      "?filter=listened&q=boards+of+canada&sort=artist-name&dir=asc",
    );
  });

  test("carries the Pick One range so it survives a trip to a release", () => {
    expect(buildListSearch({ ...defaultListViewState(null), pick: { min: 3, max: 5 } }, null)).toBe(
      "?pick=3-5",
    );
    expect(buildListSearch({ ...defaultListViewState(null), pick: { min: 4, max: 4 } }, null)).toBe(
      "?pick=4",
    );
  });

  test("omits everything left at its default", () => {
    expect(buildListSearch(defaultListViewState(null), null)).toBe("");
    expect(buildListSearch(defaultListViewState(4), 4)).toBe("");
  });

  test("the same filter is default on a stack page but not on home", () => {
    const allFilter: ListViewState = { ...defaultListViewState(null), filter: "all" };
    expect(buildListSearch(allFilter, null)).toBe("?filter=all");
    expect(buildListSearch(allFilter, 4)).toBe("");
  });

  test("round-trips through parseListViewState", () => {
    const withPick: ListViewState = { ...state, pick: { min: 2.5, max: 5 } };
    const query = buildListSearch(withPick, null);
    expect(parseListViewState(params(query.slice(1)), null)).toEqual({
      ...withPick,
      search: "boards of canada",
    });
  });
});

describe("isDefaultListViewState", () => {
  test("treats a whitespace-only search as unset", () => {
    expect(isDefaultListViewState({ ...defaultListViewState(null), search: "   " }, null)).toBe(
      true,
    );
  });

  test("is false once a control moves", () => {
    expect(
      isDefaultListViewState({ ...defaultListViewState(null), sortDirection: "asc" }, null),
    ).toBe(false);
  });

  test("ignores the Pick One range, which doesn't change what the list shows", () => {
    expect(
      isDefaultListViewState({ ...defaultListViewState(null), pick: { min: 4, max: 5 } }, null),
    ).toBe(true);
  });
});

describe("slugifyStackName / buildStackPath", () => {
  test("slugifies punctuation and casing", () => {
    expect(slugifyStackName("Dub Techno & Ambient!")).toBe("dub-techno-ambient");
  });

  test("builds the stack list path", () => {
    expect(buildStackPath(12, "Dub Techno")).toBe("/s/12/dub-techno");
  });
});

describe("stackIdFromListPath", () => {
  test("extracts the stack id", () => {
    expect(stackIdFromListPath("/s/12/dub-techno")).toBe(12);
  });

  test("returns null for the home list and other routes", () => {
    expect(stackIdFromListPath("/")).toBeNull();
    expect(stackIdFromListPath("/r/5")).toBeNull();
  });
});

describe("buildListHref", () => {
  test("joins path and query", () => {
    const state: ListViewState = { ...defaultListViewState(9), filter: "listened" };
    expect(buildListHref("/s/9/ambient", state, 9)).toBe("/s/9/ambient?filter=listened");
  });
});

describe("sanitizeListHref", () => {
  test("accepts the home list", () => {
    expect(sanitizeListHref("/")).toBe("/");
  });

  test("accepts a stack list with its browsing state", () => {
    expect(sanitizeListHref("/s/9/ambient?filter=listened&q=aphex")).toBe(
      "/s/9/ambient?filter=listened&q=aphex",
    );
  });

  test("keeps the Pick One range on the way back from a release", () => {
    expect(sanitizeListHref("/?filter=all&pick=3-4")).toBe("/?filter=all&pick=3-4");
  });

  test("drops unknown query params and normalises junk values", () => {
    expect(sanitizeListHref("/s/9/ambient?filter=bogus&evil=1")).toBe("/s/9/ambient");
  });

  test("rejects off-site and protocol-relative targets", () => {
    expect(sanitizeListHref("https://evil.test/")).toBeNull();
    expect(sanitizeListHref("//evil.test/")).toBeNull();
    expect(sanitizeListHref("/\\evil.test/")).toBeNull();
  });

  test("rejects non-list routes", () => {
    expect(sanitizeListHref("/r/5")).toBeNull();
    expect(sanitizeListHref("/settings")).toBeNull();
    expect(sanitizeListHref("/s/9/ambient/extra")).toBeNull();
  });

  test("rejects empty and missing values", () => {
    expect(sanitizeListHref(null)).toBeNull();
    expect(sanitizeListHref(undefined)).toBeNull();
    expect(sanitizeListHref("")).toBeNull();
  });
});

describe("buildReleaseHref", () => {
  test("remembers the list view it was opened from", () => {
    expect(buildReleaseHref(42, "/s/9/ambient?filter=listened")).toBe(
      "/r/42?from=%2Fs%2F9%2Fambient%3Ffilter%3Dlistened",
    );
  });

  test("stays clean for the plain home list", () => {
    expect(buildReleaseHref(42, "/")).toBe("/r/42");
    expect(buildReleaseHref(42, null)).toBe("/r/42");
  });

  test("keeps home-list browsing state", () => {
    expect(buildReleaseHref(42, "/?filter=all")).toBe("/r/42?from=%2F%3Ffilter%3Dall");
  });

  test("drops a back href that isn't a list route", () => {
    expect(buildReleaseHref(42, "https://evil.test/")).toBe("/r/42");
  });

  test("round-trips back through sanitizeListHref", () => {
    const href = buildReleaseHref(42, "/s/9/ambient?filter=listened");
    const from = new URL(href, "http://list.invalid").searchParams.get("from");
    expect(sanitizeListHref(from)).toBe("/s/9/ambient?filter=listened");
  });
});

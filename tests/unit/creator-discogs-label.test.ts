import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createMusicItemsFromUrl } from "../../server/music-item-creator";

// Freshly created items kick off background lookups — keep them off the
// network, and restore the flag afterwards so it doesn't leak into whichever
// test file `bun test` runs next (see creator-page-source-notes.test.ts).
const LOOKUPS_BEFORE = process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";

afterAll(() => {
  if (LOOKUPS_BEFORE === undefined) delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
  else process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = LOOKUPS_BEFORE;
});

afterEach(() => {
  mock.restore();
});

function discogsRelease(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      id: 5678,
      title: "Water Bearer",
      year: 1978,
      artists: [{ name: "Sally Oldfield" }],
      genres: ["Folk, World, & Country"],
      styles: ["Folk"],
      country: "UK",
      labels: [{ name: "Bronze", catno: "BRON 511" }],
      formats: [{ name: "Vinyl", descriptions: ["LP", "Album"] }],
      images: [{ type: "primary", uri: "https://img.discogs.com/water-bearer.jpg" }],
      ...overrides,
    }),
    { headers: { "content-type": "application/json" } },
  );
}

describe("createMusicItemsFromUrl: Discogs record label", () => {
  test("stores the label the Discogs release names", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(discogsRelease());

    const [result] = await createMusicItemsFromUrl(
      "https://www.discogs.com/release/5678-Sally-Oldfield-Water-Bearer",
    );

    expect(result!.created).toBe(true);
    expect(result!.item.label).toBe("Bronze");
  });

  test("leaves the label null when the release names none", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(discogsRelease({ labels: [], title: "Onze" }));

    const [result] = await createMusicItemsFromUrl(
      "https://www.discogs.com/release/5679-Sally-Oldfield-Onze",
    );

    expect(result!.item.label).toBeNull();
  });

  test("an explicit label override beats the scraped one", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(discogsRelease({ title: "Easy" }));

    const [result] = await createMusicItemsFromUrl(
      "https://www.discogs.com/release/5680-Sally-Oldfield-Easy",
      { label: "Bronze Records" },
    );

    expect(result!.item.label).toBe("Bronze Records");
  });
});

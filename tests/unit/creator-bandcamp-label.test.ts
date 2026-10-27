import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createMusicItemsFromUrl } from "../../app/music-item-creator";

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

/** A Bandcamp album page, with the credits line as Bandcamp renders it. */
function bandcampPage(credits: string): Response {
  return new Response(
    `<html><head>
      <meta property="og:title" content="My Album, by Tomorrow People" />
      <meta property="og:image" content="https://example.com/cover.jpg" />
    </head><body>
      <div class="tralbumData tralbum-credits">${credits}</div>
    </body></html>`,
    { headers: { "content-type": "text/html" } },
  );
}

describe("createMusicItemsFromUrl: Bandcamp record label", () => {
  // Each test uses a different album slug: the creator dedupes by URL, so a
  // repeat would hand back the earlier test's item instead of creating one.
  test("stores the label the credits' copyright line names", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      bandcampPage("released 14 March 2024<br>© ℗ 2024 Blue Note Records"),
    );

    const [result] = await createMusicItemsFromUrl(
      "https://tomorrowpeople.bandcamp.com/album/my-album",
    );

    expect(result!.created).toBe(true);
    expect(result!.item.label).toBe("Blue Note Records");
  });

  test("leaves the label null when the credits name no copyright line", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(bandcampPage("released 14 March 2024"));

    const [result] = await createMusicItemsFromUrl(
      "https://tomorrowpeople.bandcamp.com/album/unlabeled-album",
    );

    expect(result!.created).toBe(true);
    expect(result!.item.label).toBeNull();
  });

  test("an explicit label override beats the scraped one", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      bandcampPage("released 14 March 2024<br>© ℗ 2024 Blue Note Records"),
    );

    const [result] = await createMusicItemsFromUrl(
      "https://tomorrowpeople.bandcamp.com/album/overridden-album",
      { label: "Tomorrow People Recordings" },
    );

    expect(result!.created).toBe(true);
    expect(result!.item.label).toBe("Tomorrow People Recordings");
  });
});

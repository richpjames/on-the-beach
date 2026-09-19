import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createMusicItemsFromUrl } from "../../app/music-item-creator";
import { DEFAULT_ARTIST_WATCH_SETTINGS, setArtistWatchSettings } from "../../app/settings";

// Freshly created items kick off background lookups — keep them off the
// network, and restore the flag afterwards so it doesn't leak into whichever
// test file `bun test` runs next (see creator-page-source-notes.test.ts).
const LOOKUPS_BEFORE = process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";

afterAll(() => {
  if (LOOKUPS_BEFORE === undefined) delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
  else process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = LOOKUPS_BEFORE;
});

// Settings are a shared table: put them back so a test that switches
// scheduling off doesn't decide the next file's behaviour.
beforeEach(async () => {
  await setArtistWatchSettings(DEFAULT_ARTIST_WATCH_SETTINGS);
});

afterEach(async () => {
  mock.restore();
  await setArtistWatchSettings(DEFAULT_ARTIST_WATCH_SETTINGS);
});

/** A Bandcamp album page, with the release date where the credits line puts it. */
function bandcampPage(title: string, credits: string): Response {
  return new Response(
    `<html><head>
      <meta property="og:title" content="${title}, by Tomorrow People" />
      <meta property="og:image" content="https://example.com/cover.jpg" />
    </head><body>
      <div class="tralbumData tralbum-credits">${credits}</div>
    </body></html>`,
    { headers: { "content-type": "text/html" } },
  );
}

describe("createMusicItemsFromUrl: Bandcamp release date", () => {
  test("schedules a pre-order for the day the page says it comes out", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      bandcampPage("Coming Soon", "releases 2 June 2099"),
    );

    const [result] = await createMusicItemsFromUrl(
      "https://tomorrowpeople.bandcamp.com/album/coming-soon",
    );

    expect(result!.created).toBe(true);
    // Stored as a timestamp, so read it back through Date rather than as text.
    expect(new Date(result!.item.remind_at!).toISOString()).toBe("2099-06-02T00:00:00.000Z");
    expect(result!.item.year).toBe(2099);
  });

  test("a record already out is added to To Listen, not scheduled", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      bandcampPage("Long Out", "released 14 March 1999"),
    );

    const [result] = await createMusicItemsFromUrl(
      "https://tomorrowpeople.bandcamp.com/album/long-out",
    );

    expect(result!.item.remind_at).toBeNull();
    expect(result!.item.listen_status).toBe("to-listen");
    expect(result!.item.year).toBe(1999);
  });

  test("with scheduling switched off a pre-order is an ordinary add", async () => {
    await setArtistWatchSettings({ scheduleAnnouncedReleases: false });
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      bandcampPage("Unscheduled", "releases 2 June 2099"),
    );

    const [result] = await createMusicItemsFromUrl(
      "https://tomorrowpeople.bandcamp.com/album/unscheduled",
    );

    expect(result!.item.remind_at).toBeNull();
    // The date still dates the record, even when it isn't scheduled for it.
    expect(result!.item.year).toBe(2099);
  });

  test("leaves the item unscheduled when the page names no date", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(bandcampPage("Undated", "by Some Label"));

    const [result] = await createMusicItemsFromUrl(
      "https://tomorrowpeople.bandcamp.com/album/undated",
    );

    expect(result!.item.remind_at).toBeNull();
    expect(result!.item.year).toBeNull();
  });
});

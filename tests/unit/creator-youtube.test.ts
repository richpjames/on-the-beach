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

/** YouTube's oEmbed answer: a video title and the channel that uploaded it. */
function oEmbed(title: string, channel: string): Response {
  return new Response(
    JSON.stringify({
      title,
      author_name: channel,
      thumbnail_url: "https://i.ytimg.com/vi/abc123/hqdefault.jpg",
    }),
    { headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

describe("createMusicItemsFromUrl: YouTube", () => {
  // Each test uses a different video id: the creator dedupes by URL, so a
  // repeat would hand back the earlier test's item instead of creating one.
  test("files a vinyl rip under the artist in the video title, not the uploader", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      oEmbed("Rosinha de Valença - 1973", "Cesar b costa"),
    );

    const [result] = await createMusicItemsFromUrl("https://www.youtube.com/watch?v=baKM26Rvzoo");

    expect(result!.created).toBe(true);
    expect(result!.item.artist_name).toBe("Rosinha De Valença");
    expect(result!.item.title).toBe("1973");
    // The year is the title here, not a release date — see classifyYouTubeVideo.
    expect(result!.item.year).toBeNull();
  });

  test("stores the year the uploader set beside the title", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      oEmbed("Marcos Valle – Previsão do Tempo (1973) [Full Album]", "Vinyl Rips"),
    );

    const [result] = await createMusicItemsFromUrl("https://www.youtube.com/watch?v=prevTempo73");

    expect(result!.created).toBe(true);
    expect(result!.item.artist_name).toBe("Marcos Valle");
    expect(result!.item.title).toBe("Previsão Do Tempo");
    expect(result!.item.year).toBe(1973);
  });

  test("an artist and title typed with the link still win", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      oEmbed("Rosinha de Valença - 1973", "Cesar b costa"),
    );

    const [result] = await createMusicItemsFromUrl("https://www.youtube.com/watch?v=typedOver1", {
      artistName: "Rosinha de Valença",
      title: "Rosinha de Valença",
    });

    expect(result!.created).toBe(true);
    expect(result!.item.artist_name).toBe("Rosinha De Valença");
    expect(result!.item.title).toBe("Rosinha De Valença");
  });
});

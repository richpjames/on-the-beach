import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  judgeYouTubeCandidate,
  searchYouTube,
  type YouTubeCandidate,
} from "../../server/youtube-search";

function candidate(title: string, channelTitle = "Some Uploader"): YouTubeCandidate {
  return { videoId: "abc123", title, channelTitle };
}

function searchResponse(items: { videoId: string; title: string; channelTitle: string }[]) {
  return new Response(
    JSON.stringify({
      items: items.map(({ videoId, title, channelTitle }) => ({
        id: { kind: "youtube#video", videoId },
        snippet: { title, channelTitle },
      })),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("judgeYouTubeCandidate", () => {
  test("accepts an upload on the artist's auto-generated Topic channel", () => {
    const verdict = judgeYouTubeCandidate(
      candidate("Unfinished Sympathy", "Massive Attack - Topic"),
      "Unfinished Sympathy",
      "Massive Attack",
    );
    expect(verdict).toEqual({ confident: true, reason: "topic_channel" });
  });

  test("accepts an upload on the artist's own channel", () => {
    const verdict = judgeYouTubeCandidate(
      candidate("Blue Lines (Full Album)", "MassiveAttackVEVO"),
      "Blue Lines",
      "Massive Attack",
    );
    expect(verdict).toEqual({ confident: true, reason: "artist_channel" });
  });

  test("accepts a third-party upload naming both artist and release", () => {
    const verdict = judgeYouTubeCandidate(
      candidate("Massive Attack - Blue Lines [Official Audio]", "Trip Hop Archive"),
      "Blue Lines",
      "Massive Attack",
    );
    expect(verdict).toEqual({ confident: true, reason: "title_and_artist" });
  });

  test("matches across HTML entities and punctuation in the video title", () => {
    const verdict = judgeYouTubeCandidate(
      candidate("Sonic Youth &quot;Rock &amp; Roll&quot; (1985)", "Noise Vault"),
      "Rock & Roll",
      "Sonic Youth",
    );
    expect(verdict.confident).toBe(true);
  });

  test("rejects a video that doesn't name the release", () => {
    const verdict = judgeYouTubeCandidate(
      candidate("Massive Attack - Safe From Harm", "Trip Hop Archive"),
      "Blue Lines",
      "Massive Attack",
    );
    expect(verdict).toEqual({ confident: false, reason: "title_mismatch" });
  });

  test("rejects a different artist's recording of the same title", () => {
    const verdict = judgeYouTubeCandidate(
      candidate("Nirvana - Blue Lines", "Grunge Uploads"),
      "Blue Lines",
      "Massive Attack",
    );
    expect(verdict).toEqual({ confident: false, reason: "artist_mismatch" });
  });

  test.each([
    "Massive Attack - Blue Lines (Cover by Jane Doe)",
    "Massive Attack - Blue Lines [Karaoke Version]",
    "Massive Attack - Blue Lines (Live at Glastonbury 1995)",
    "Massive Attack - Blue Lines (Sasha Remix)",
    "Massive Attack - Blue Lines REACTION!!",
    "Massive Attack - Blue Lines | Guitar Tab tutorial",
    "Massive Attack - Blue Lines (slowed + reverb)",
    "Massive Attack - Blue Lines — instrumental",
  ])("rejects a different version of the recording: %s", (videoTitle) => {
    const verdict = judgeYouTubeCandidate(candidate(videoTitle), "Blue Lines", "Massive Attack");
    expect(verdict).toEqual({ confident: false, reason: "other_version" });
  });

  test("rejects a karaoke channel even when the video title looks clean", () => {
    const verdict = judgeYouTubeCandidate(
      candidate("Massive Attack - Blue Lines", "Massive Attack Karaoke Backings"),
      "Blue Lines",
      "Massive Attack",
    );
    expect(verdict).toEqual({ confident: false, reason: "other_version" });
  });

  test("does not disqualify a release whose own title carries a marker word", () => {
    const verdict = judgeYouTubeCandidate(
      candidate("Talking Heads - The Name of This Band Is Talking Heads (Live)", "Heads Archive"),
      "The Name of This Band Is Talking Heads (Live)",
      "Talking Heads",
    );
    expect(verdict.confident).toBe(true);
  });

  test("ignores a Wikipedia-style disambiguator on the release title", () => {
    const verdict = judgeYouTubeCandidate(
      candidate("Michael Nyman - Michael Nyman", "Minimalism Archive"),
      "Michael Nyman (1981 album)",
      "Michael Nyman",
    );
    expect(verdict.confident).toBe(true);
  });

  test("refuses to judge anything without an artist", () => {
    expect(judgeYouTubeCandidate(candidate("Blue Lines"), "Blue Lines", null)).toEqual({
      confident: false,
      reason: "no_artist",
    });
  });
});

describe("searchYouTube", () => {
  const previousKey = process.env.YOUTUBE_API_KEY;

  beforeEach(() => {
    delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
    process.env.YOUTUBE_API_KEY = "test-key";
  });

  afterEach(() => {
    if (previousKey === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = previousKey;
    delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
    mock.restore();
  });

  test("returns null without an API key, and never fetches", async () => {
    delete process.env.YOUTUBE_API_KEY;
    const fetchSpy = spyOn(globalThis, "fetch");
    expect(await searchYouTube("Blue Lines", "Massive Attack")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("no-ops under OTB_DISABLE_EXTERNAL_LOOKUPS", async () => {
    process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";
    const fetchSpy = spyOn(globalThis, "fetch");
    expect(await searchYouTube("Blue Lines", "Massive Attack")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("doesn't spend quota on an item with no artist", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    expect(await searchYouTube("Blue Lines", null)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("returns the watch URL of the first confident match", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      searchResponse([
        {
          videoId: "wrong1",
          title: "Massive Attack - Blue Lines (Karaoke)",
          channelTitle: "Sing Along",
        },
        {
          videoId: "right1",
          title: "Blue Lines",
          channelTitle: "Massive Attack - Topic",
        },
      ]),
    );

    const result = await searchYouTube("Blue Lines", "Massive Attack");
    expect(result).toEqual({ url: "https://www.youtube.com/watch?v=right1", artworkUrl: null });

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toStartWith("https://www.googleapis.com/youtube/v3/search?");
    expect(url).toContain("key=test-key");
    expect(url).toContain("videoCategoryId=10");
    expect(url).toContain("videoEmbeddable=true");
    expect(url).toContain("q=Massive+Attack+Blue+Lines");
  });

  test("returns null when nothing clears the confidence bar", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      searchResponse([
        { videoId: "v1", title: "Blue Lines full album REACTION", channelTitle: "Reactions Daily" },
        { videoId: "v2", title: "Massive Attack Mix 2024", channelTitle: "Chill Beats" },
      ]),
    );
    expect(await searchYouTube("Blue Lines", "Massive Attack")).toBeNull();
  });

  test("returns null on an API error", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect(await searchYouTube("Blue Lines", "Massive Attack")).toBeNull();
  });

  test("returns null when the request fails", async () => {
    spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    expect(await searchYouTube("Blue Lines", "Massive Attack")).toBeNull();
  });
});

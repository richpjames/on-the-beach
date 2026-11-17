import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  extractReleaseCandidatesFromWebText,
  parseReleaseCandidatesJson,
  pickPrimaryReleaseCandidate,
} from "../../adapters/web/link-extractor";

describe("parseReleaseCandidatesJson", () => {
  test("parses multiple releases from JSON", () => {
    const result = parseReleaseCandidatesJson(`
      {
        "releases": [
          { "artist": "Artist One", "title": "First Album", "itemType": "album" },
          { "artist": "Artist Two", "title": "Second EP", "itemType": "ep" }
        ]
      }
    `);

    expect(result).toEqual([
      {
        candidateId: "cand-1-artist-one-first-album",
        artist: "Artist One",
        title: "First Album",
        itemType: "album",
      },
      {
        candidateId: "cand-2-artist-two-second-ep",
        artist: "Artist Two",
        title: "Second EP",
        itemType: "ep",
      },
    ]);
  });

  test("uses artist as title for self-titled releases when title is null", () => {
    const result = parseReleaseCandidatesJson(`
      {
        "releases": [
          { "artist": "Burial", "title": null, "itemType": "album" }
        ]
      }
    `);

    expect(result).toEqual([
      {
        candidateId: "cand-1-burial-burial",
        artist: "Burial",
        title: "Burial",
        itemType: "album",
      },
    ]);
  });

  test("deduplicates repeated releases and ignores invalid entries", () => {
    const result = parseReleaseCandidatesJson(`
      {
        "releases": [
          { "artist": "Theo Parrish", "title": "In Motion", "itemType": "album" },
          { "artist": "Theo Parrish", "title": "In Motion", "itemType": "album" },
          { "artist": null, "title": null, "itemType": "album" }
        ]
      }
    `);

    expect(result).toEqual([
      {
        candidateId: "cand-1-theo-parrish-in-motion",
        artist: "Theo Parrish",
        title: "In Motion",
        itemType: "album",
      },
    ]);
  });
});

describe("pickPrimaryReleaseCandidate", () => {
  test("picks the obvious product-page release when url slug matches it strongly", () => {
    const result = pickPrimaryReleaseCandidate(
      "https://ripgrooves.com/products/katie-webster-the-swamp-boogie-queen-cd-mint-m",
      [
        {
          candidateId: "cand-1",
          artist: "Katie Webster",
          title: "The Swamp Boogie Queen",
          itemType: "album",
          confidence: 0.84,
        },
        {
          candidateId: "cand-2",
          artist: "B.B. King",
          title: "Live in Cook County Jail",
          itemType: "album",
          confidence: 0.41,
        },
      ],
    );

    expect(result?.candidateId).toBe("cand-1");
  });

  test("returns null when several releases are peer candidates", () => {
    const result = pickPrimaryReleaseCandidate(
      "https://mailchi.mp/27f45c3c5d8f/the-meditationsnewsletter-17475884",
      [
        {
          candidateId: "cand-1",
          artist: "Artist One",
          title: "Release One",
          itemType: "album",
          confidence: 0.56,
        },
        {
          candidateId: "cand-2",
          artist: "Artist Two",
          title: "Release Two",
          itemType: "album",
          confidence: 0.54,
        },
      ],
    );

    expect(result).toBeNull();
  });
});

function mockChatCompletionResponse(content: unknown): Response {
  return new Response(
    JSON.stringify({
      id: "cmpl_test_1",
      object: "chat.completion",
      created: 1,
      model: "mistral-small-latest",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    }),
    { headers: { "content-type": "application/json" } },
  );
}

describe("extractReleaseCandidatesFromWebText — failure taxonomy", () => {
  const originalEnv = { ...process.env };
  const url = "https://example-radio.net/episode/late-night-jazz";
  const pageText = "Listen back to the late night jazz show. Tracklist below.";

  afterEach(() => {
    mock.restore();
    process.env = { ...originalEnv };
  });

  test("reports no-key without calling the service", async () => {
    delete process.env.MISTRAL_API_KEY;
    const fetchSpy = spyOn(globalThis, "fetch");

    const result = await extractReleaseCandidatesFromWebText(url, pageText);

    expect(result).toEqual({ releases: [], failure: "no-key" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("reports nothing found, without a failure, when the answer names no releases", async () => {
    process.env.MISTRAL_API_KEY = "test-key";
    spyOn(globalThis, "fetch").mockResolvedValueOnce(mockChatCompletionResponse('{"releases":[]}'));

    const result = await extractReleaseCandidatesFromWebText(url, pageText);

    expect(result).toEqual({ releases: [] });
  });

  test("reports nothing found, without a failure, for an empty snippet", async () => {
    process.env.MISTRAL_API_KEY = "test-key";
    const fetchSpy = spyOn(globalThis, "fetch");

    const result = await extractReleaseCandidatesFromWebText(url, "   ");

    expect(result).toEqual({ releases: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("reports api-error when the service rejects the call", async () => {
    process.env.MISTRAL_API_KEY = "test-key";
    spyOn(console, "error").mockImplementation(() => {});
    // 401 is not retried by the SDK, so one mocked response is enough.
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await extractReleaseCandidatesFromWebText(url, pageText);

    // The raw provider error stays in the server log, not in the result.
    expect(result).toEqual({ releases: [], failure: "api-error" });
  });

  test("reports api-error when the service can't be reached", async () => {
    process.env.MISTRAL_API_KEY = "test-key";
    spyOn(console, "error").mockImplementation(() => {});
    spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("connection reset"));

    const result = await extractReleaseCandidatesFromWebText(url, pageText);

    expect(result).toEqual({ releases: [], failure: "api-error" });
  });

  test("reports bad-response for an unreadable answer", async () => {
    process.env.MISTRAL_API_KEY = "test-key";
    spyOn(console, "error").mockImplementation(() => {});
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockChatCompletionResponse("Sorry, I can't help with that."),
    );

    const result = await extractReleaseCandidatesFromWebText(url, pageText);

    expect(result).toEqual({ releases: [], failure: "bad-response" });
  });

  test("reports bad-response when the answer carries no text", async () => {
    process.env.MISTRAL_API_KEY = "test-key";
    spyOn(console, "error").mockImplementation(() => {});
    spyOn(globalThis, "fetch").mockResolvedValueOnce(mockChatCompletionResponse(null));

    const result = await extractReleaseCandidatesFromWebText(url, pageText);

    expect(result).toEqual({ releases: [], failure: "bad-response" });
  });

  test("returns the candidates without a failure when the answer is readable", async () => {
    process.env.MISTRAL_API_KEY = "test-key";
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockChatCompletionResponse(
        '{"releases":[{"artist":"DJ Example","title":"Late Night Jazz","itemType":"mix"}]}',
      ),
    );

    const result = await extractReleaseCandidatesFromWebText(url, pageText);

    expect(result.failure).toBeUndefined();
    expect(result.releases).toEqual([
      {
        candidateId: "cand-1-dj-example-late-night-jazz",
        artist: "DJ Example",
        title: "Late Night Jazz",
        itemType: "mix",
      },
    ]);
  });
});

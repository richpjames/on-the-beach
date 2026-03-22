import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { AmbiguousLinkApiError, ApiClient } from "../../src/services/api-client";

describe("ApiClient.createMusicItem", () => {
  afterEach(() => {
    mock.restore();
  });

  test("throws AmbiguousLinkApiError when the server returns ambiguous link candidates", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          kind: "ambiguous_link",
          url: "https://example.com/newsletter",
          message: "This link mentions several releases. Pick one or more to add.",
          candidates: [
            {
              candidateId: "cand-1",
              artist: "Artist One",
              title: "Release One",
              itemType: "album",
            },
          ],
        }),
        {
          status: 409,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const client = new ApiClient();

    let thrown: unknown;
    try {
      await client.createMusicItem({ url: "https://example.com/newsletter" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AmbiguousLinkApiError);
    expect((thrown as AmbiguousLinkApiError).payload).toEqual({
      kind: "ambiguous_link",
      url: "https://example.com/newsletter",
      message: "This link mentions several releases. Pick one or more to add.",
      candidates: [
        {
          candidateId: "cand-1",
          artist: "Artist One",
          title: "Release One",
          itemType: "album",
        },
      ],
    });
  });
});

describe("ApiClient.appleMusicLookup", () => {
  afterEach(() => {
    mock.restore();
  });

  test("calls the apple-music-lookup endpoint with POST", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ url: "https://music.apple.com/album/123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const client = new ApiClient("https://example.com");
    await client.appleMusicLookup(7);

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://example.com/api/release/apple-music-lookup/7",
      { method: "POST" },
    );
  });
});

describe("ApiClient.listMusicItems", () => {
  afterEach(() => {
    mock.restore();
  });

  test("includes search, stack, and sort query params", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [], total: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const client = new ApiClient("https://example.com");
    await client.listMusicItems({
      listenStatus: "listened",
      search: "dub",
      stackId: 7,
      sort: "star-rating",
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://example.com/api/music-items?listenStatus=listened&search=dub&stackId=7&sort=star-rating",
      undefined,
    );
  });
});

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  AmbiguousLinkApiError,
  ApiClient,
  DuplicateItemApiError,
} from "../../src/services/api-client";

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
  test("throws DuplicateItemApiError when the server returns duplicate items", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          kind: "duplicate_item",
          url: "https://music.apple.com/gb/album/some-album/123",
          message: "This looks like something already in your list.",
          items: [
            {
              id: 7,
              title: "Some Album",
              artist_name: "Some Artist",
              listen_status: "to-listen",
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
      await client.createMusicItem({
        url: "https://music.apple.com/gb/album/some-album/123",
        warnOnDuplicate: true,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DuplicateItemApiError);
    const payload = (thrown as DuplicateItemApiError).payload;
    expect(payload.kind).toBe("duplicate_item");
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]!.title).toBe("Some Album");
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

  test("forwards an abort signal so a superseded list fetch can be cancelled", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [], total: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const client = new ApiClient();
    const controller = new AbortController();
    await client.listMusicItems({ search: "dub" }, { signal: controller.signal });

    expect(fetchSpy).toHaveBeenCalledWith("/api/music-items?search=dub", {
      signal: controller.signal,
    });
  });
});

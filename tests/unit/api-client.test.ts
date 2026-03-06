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
          message: "This link mentions several releases. Pick one to add.",
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
      message: "This link mentions several releases. Pick one to add.",
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

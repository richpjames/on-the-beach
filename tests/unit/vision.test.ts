import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { extractAlbumInfo } from "../../server/vision";

function mockCompletionResponse(content: string | Array<{ type: string; text: string }>): Response {
  return new Response(
    JSON.stringify({
      id: "cmpl_test_1",
      object: "chat.completion",
      created: 1,
      model: "mistral-small-latest",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content,
          },
        },
      ],
    }),
    {
      headers: { "content-type": "application/json" },
    },
  );
}

describe("extractAlbumInfo", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.MISTRAL_API_KEY = "test-key";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    mock.restore();
  });

  test("returns artist and title from valid JSON content", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockCompletionResponse('{"artist":"Radiohead","title":"OK Computer"}'),
    );

    const result = await extractAlbumInfo("base64-image-data");
    expect(result).toEqual({ artist: "Radiohead", title: "OK Computer" });
  });

  test("handles fenced JSON and nullable values", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockCompletionResponse('```json\n{"artist":null,"title":"Uncertain"}\n```'),
    );

    const result = await extractAlbumInfo("base64-image-data");
    expect(result).toEqual({ artist: null, title: "Uncertain" });
  });

  test("returns null for non-JSON assistant output", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockCompletionResponse("I can't identify this cover confidently."),
    );

    const result = await extractAlbumInfo("base64-image-data");
    expect(result).toBeNull();
  });

  test("returns null when provider request fails", async () => {
    spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network down"));

    const result = await extractAlbumInfo("base64-image-data");
    expect(result).toBeNull();
  });
});

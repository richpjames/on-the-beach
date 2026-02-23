import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { extractAlbumInfo } from "../../server/vision";

function mockChatCompletionResponse(
  content: string | Array<{ type: string; text: string }>,
): Response {
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

function mockOcrResponse(payload: {
  documentAnnotation?: string;
  pages?: Array<{ markdown: string }>;
}): Response {
  return new Response(
    JSON.stringify({
      model: "mistral-ocr-latest",
      usage_info: {
        pages_processed: 1,
        doc_size_bytes: 1000,
      },
      pages: (payload.pages ?? []).map((page, index) => ({
        index,
        markdown: page.markdown,
        images: [],
        dimensions: {
          dpi: 72,
          width: 800,
          height: 800,
        },
      })),
      document_annotation: payload.documentAnnotation ?? null,
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
    delete process.env.MISTRAL_SCAN_MODEL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    mock.restore();
  });

  test("uses OCR by default and parses document annotation JSON", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockOcrResponse({
        documentAnnotation: '{"artist":"Radiohead","title":"OK Computer"}',
      }),
    );

    const result = await extractAlbumInfo("base64-image-data");
    expect(result).toEqual({ artist: "Radiohead", title: "OK Computer" });
  });

  test("parses OCR JSON found in page markdown when annotation is missing", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockOcrResponse({
        pages: [{ markdown: '{"artist":"Bonobo","title":"Migration"}' }],
      }),
    );

    const result = await extractAlbumInfo("base64-image-data");
    expect(result).toEqual({ artist: "Bonobo", title: "Migration" });
  });

  test("supports chat model fallback via MISTRAL_SCAN_MODEL", async () => {
    process.env.MISTRAL_SCAN_MODEL = "mistral-small-latest";

    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockChatCompletionResponse('{"artist":"Massive Attack","title":"Mezzanine"}'),
    );

    const result = await extractAlbumInfo("base64-image-data");
    expect(result).toEqual({ artist: "Massive Attack", title: "Mezzanine" });
  });

  test("returns null for non-JSON assistant output", async () => {
    process.env.MISTRAL_SCAN_MODEL = "mistral-small-latest";

    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockChatCompletionResponse("I can't identify this cover confidently."),
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

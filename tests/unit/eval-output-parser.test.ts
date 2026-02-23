import { describe, expect, test } from "bun:test";
import { parseBatchOutput, parseOcrTextBatchOutput } from "../../eval/output-parser";

describe("parseBatchOutput", () => {
  test("parses chat output with string message content", () => {
    const parsed = parseBatchOutput(
      {
        custom_id: "radiohead-ok-computer",
        response: {
          body: {
            choices: [
              {
                message: {
                  content: '{"artist":"Radiohead","title":"OK Computer"}',
                },
              },
            ],
          },
        },
      },
      "chat",
    );

    expect(parsed.customId).toBe("radiohead-ok-computer");
    expect(parsed.actual).toEqual({ artist: "Radiohead", title: "OK Computer" });
  });

  test("parses chat output with text chunks", () => {
    const parsed = parseBatchOutput(
      {
        custom_id: "bonobo-migration",
        response: {
          body: {
            choices: [
              {
                message: {
                  content: [{ type: "text", text: '{"artist":"Bonobo","title":"Migration"}' }],
                },
              },
            ],
          },
        },
      },
      "chat",
    );

    expect(parsed.customId).toBe("bonobo-migration");
    expect(parsed.actual).toEqual({ artist: "Bonobo", title: "Migration" });
  });

  test("parses OCR output document_annotation response", () => {
    const parsed = parseBatchOutput(
      {
        custom_id: "caetano-veloso",
        response: {
          body: {
            document_annotation: '{"artist":"Caetano Veloso","title":"Caetano Veloso"}',
          },
        },
      },
      "ocr",
    );

    expect(parsed.customId).toBe("caetano-veloso");
    expect(parsed.actual).toEqual({ artist: "Caetano Veloso", title: "Caetano Veloso" });
  });

  test("handles OCR output using camelCase documentAnnotation", () => {
    const parsed = parseBatchOutput(
      {
        customId: "lecuona-plays-for-two",
        response: {
          body: {
            documentAnnotation: '{"artist":"Lecuona","title":"Plays For Two"}',
          },
        },
      },
      "ocr",
    );

    expect(parsed.customId).toBe("lecuona-plays-for-two");
    expect(parsed.actual).toEqual({ artist: "Lecuona", title: "Plays For Two" });
  });
});

describe("parseOcrTextBatchOutput", () => {
  test("extracts OCR text from page markdown", () => {
    const parsed = parseOcrTextBatchOutput({
      custom_id: "machito-tanga",
      response: {
        body: {
          pages: [{ markdown: "# MACHITO\nTanga" }, { markdown: "Afro-Cubans" }],
        },
      },
    });

    expect(parsed.customId).toBe("machito-tanga");
    expect(parsed.text).toBe("# MACHITO\nTanga\n\nAfro-Cubans");
  });

  test("falls back to document annotation when pages are missing", () => {
    const parsed = parseOcrTextBatchOutput({
      custom_id: "fallback",
      response: {
        body: {
          document_annotation: "RICO RICO\n50 EXITOS TROPICALES",
        },
      },
    });

    expect(parsed.customId).toBe("fallback");
    expect(parsed.text).toBe("RICO RICO\n50 EXITOS TROPICALES");
  });
});

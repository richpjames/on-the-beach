import { describe, expect, test } from "bun:test";
import { buildRawOcrReport } from "../../eval/raw-ocr-report";
import type { EvalCase } from "../../eval/types";

describe("buildRawOcrReport", () => {
  test("preserves raw OCR text and includes null for missing cases", () => {
    const cases: EvalCase[] = [
      {
        id: "case-a",
        image: "images/a.jpg",
        artist: "Artist A",
        title: "Title A",
      },
      {
        id: "case-b",
        image: "images/b.jpg",
        artist: "Artist B",
        title: "Title B",
      },
    ];

    const ocrTextByModel = new Map<string, Map<string, string>>([
      ["mistral-ocr-latest", new Map([["case-a", "RAW OCR TEXT A"]])],
    ]);

    const report = buildRawOcrReport({
      timestamp: "2026-02-24T12:00:00.000Z",
      cases,
      ocrTextByModel,
    });

    expect(report).toEqual({
      timestamp: "2026-02-24T12:00:00.000Z",
      caseCount: 2,
      models: ["mistral-ocr-latest"],
      results: {
        "mistral-ocr-latest": [
          { id: "case-a", text: "RAW OCR TEXT A" },
          { id: "case-b", text: null },
        ],
      },
    });
  });

  test("returns empty results when there are no OCR models", () => {
    const report = buildRawOcrReport({
      timestamp: "2026-02-24T12:00:00.000Z",
      cases: [],
      ocrTextByModel: new Map(),
    });

    expect(report).toEqual({
      timestamp: "2026-02-24T12:00:00.000Z",
      caseCount: 0,
      models: [],
      results: {},
    });
  });
});

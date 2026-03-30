import { describe, expect, test } from "bun:test";
import { parseScanJson } from "../../server/scan-parser";

describe("parseScanJson", () => {
  test("parses valid JSON with artist and title", () => {
    expect(parseScanJson('{"artist":"Radiohead","title":"OK Computer"}')).toEqual({
      artist: "Radiohead",
      title: "OK Computer",
      artistConfidence: 0,
      titleConfidence: 0,
    });
  });

  test("parses per-field confidence when present", () => {
    expect(
      parseScanJson(
        '{"artist":"Radiohead","title":"OK Computer","artistConfidence":0.95,"titleConfidence":0.7}',
      ),
    ).toEqual({
      artist: "Radiohead",
      title: "OK Computer",
      artistConfidence: 0.95,
      titleConfidence: 0.7,
    });
  });

  test("clamps artistConfidence and titleConfidence to [0, 1]", () => {
    expect(
      parseScanJson('{"artist":"X","title":"Y","artistConfidence":1.5,"titleConfidence":-0.5}'),
    ).toEqual({
      artist: "X",
      title: "Y",
      artistConfidence: 1,
      titleConfidence: 0,
    });
  });

  test("handles fenced JSON", () => {
    expect(parseScanJson('```json\n{"artist":"Bonobo","title":"Migration"}\n```')).toEqual({
      artist: "Bonobo",
      title: "Migration",
      artistConfidence: 0,
      titleConfidence: 0,
    });
  });

  test("coerces empty strings to null", () => {
    expect(parseScanJson('{"artist":"","title":"OK Computer"}')).toEqual({
      artist: null,
      title: "OK Computer",
      artistConfidence: 0,
      titleConfidence: 0,
    });
  });

  test("coerces literal null strings to null", () => {
    expect(parseScanJson('{"artist":"NULL","title":" null "}')).toEqual({
      artist: null,
      title: null,
      artistConfidence: 0,
      titleConfidence: 0,
    });
  });

  test("returns null for invalid JSON", () => {
    expect(parseScanJson("not json")).toBeNull();
  });

  test("returns null for non-object JSON", () => {
    expect(parseScanJson('"just a string"')).toBeNull();
  });

  test("returns null when artist is a number", () => {
    expect(parseScanJson('{"artist":123,"title":"OK Computer"}')).toBeNull();
  });
});

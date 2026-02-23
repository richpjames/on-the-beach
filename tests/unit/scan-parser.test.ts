import { describe, expect, test } from "bun:test";
import { parseScanJson } from "../../server/scan-parser";

describe("parseScanJson", () => {
  test("parses valid JSON with artist and title", () => {
    expect(parseScanJson('{"artist":"Radiohead","title":"OK Computer"}')).toEqual({
      artist: "Radiohead",
      title: "OK Computer",
    });
  });

  test("handles fenced JSON", () => {
    expect(parseScanJson('```json\n{"artist":"Bonobo","title":"Migration"}\n```')).toEqual({
      artist: "Bonobo",
      title: "Migration",
    });
  });

  test("coerces empty strings to null", () => {
    expect(parseScanJson('{"artist":"","title":"OK Computer"}')).toEqual({
      artist: null,
      title: "OK Computer",
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

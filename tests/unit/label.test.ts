import { describe, test, expect } from "bun:test";
import { labelNameFromCopyrightLine } from "../../domain/label";

describe("labelNameFromCopyrightLine", () => {
  test("strips the phonogram symbol and year", () => {
    expect(labelNameFromCopyrightLine("℗ 2024 Bronze")).toBe("Bronze");
  });

  test("strips doubled copyright symbols and the year", () => {
    expect(labelNameFromCopyrightLine("© & ℗ 2024 XL Recordings")).toBe("XL Recordings");
  });

  test("strips a comma-separated run of years", () => {
    expect(labelNameFromCopyrightLine("℗ 2023, 2024 Warp")).toBe("Warp");
  });

  test("strips a year range joined by a dash", () => {
    expect(labelNameFromCopyrightLine("℗ 2023-2024 Warp")).toBe("Warp");
  });

  test("strips a spaced year range", () => {
    expect(labelNameFromCopyrightLine("℗ 2023 – 2024 Warp")).toBe("Warp");
    expect(labelNameFromCopyrightLine("© 2023 — 2024 Warp")).toBe("Warp");
  });

  test("keeps a label that itself begins with digits", () => {
    expect(labelNameFromCopyrightLine("© 2024 4AD")).toBe("4AD");
    expect(labelNameFromCopyrightLine("℗ 100-200 Records")).toBe("100-200 Records");
  });

  test("keeps the name when there is no year", () => {
    expect(labelNameFromCopyrightLine("℗ Hyperdub")).toBe("Hyperdub");
  });

  test("returns undefined when only symbols and year(s) remain", () => {
    expect(labelNameFromCopyrightLine("℗ 2024")).toBeUndefined();
    expect(labelNameFromCopyrightLine("© ℗ 2024")).toBeUndefined();
    expect(labelNameFromCopyrightLine("℗ 2023-2024")).toBeUndefined();
  });

  test("returns undefined for blanks", () => {
    expect(labelNameFromCopyrightLine("")).toBeUndefined();
    expect(labelNameFromCopyrightLine("   ")).toBeUndefined();
  });
});

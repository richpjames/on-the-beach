import { describe, expect, it } from "bun:test";

import {
  buildCreateMusicItemInputFromValues,
  getCoverScanErrorMessage,
  hasAnyNonEmptyField,
} from "../../src/ui/domain/add-form";
import { buildMusicItemFilters, getEmptyStateMessage } from "../../src/ui/domain/music-list";
import { constrainDimensions } from "../../src/ui/domain/scan";

describe("app domain helpers", () => {
  it("detects whether add form has any user input", () => {
    expect(hasAnyNonEmptyField(["", "   "])).toBe(false);
    expect(hasAnyNonEmptyField(["", " title "])).toBe(true);
  });

  it("builds a create payload and normalizes URL fields", () => {
    const payload = buildCreateMusicItemInputFromValues({
      url: "example.com/release",
      title: "Title",
      artist: "Artist",
      itemType: "album",
      label: "Label",
      year: "2024",
      country: "UK",
      genre: "Dub",
      catalogueNumber: "CAT-1",
      notes: "Notes",
      artworkUrl: "cdn.example.com/art.jpg",
    });

    expect(payload).toEqual({
      url: "https://example.com/release",
      title: "Title",
      artistName: "Artist",
      itemType: "album",
      label: "Label",
      year: 2024,
      country: "UK",
      genre: "Dub",
      catalogueNumber: "CAT-1",
      notes: "Notes",
      artworkUrl: "https://cdn.example.com/art.jpg",
    });
  });

  it("preserves upload artwork paths without protocol", () => {
    const payload = buildCreateMusicItemInputFromValues({
      url: "",
      title: "",
      artist: "",
      itemType: "album",
      label: "",
      year: "",
      country: "",
      genre: "",
      catalogueNumber: "",
      notes: "",
      artworkUrl: "/uploads/test.jpg",
    });

    expect(payload.artworkUrl).toBe("/uploads/test.jpg");
  });

  it("returns API filter object only when needed", () => {
    expect(buildMusicItemFilters("all", null)).toBeUndefined();
    expect(buildMusicItemFilters("listened", null)).toEqual({ listenStatus: "listened" });
    expect(buildMusicItemFilters("all", 7)).toEqual({ stackId: 7 });
  });

  it("builds the same empty-state messages used by the UI", () => {
    expect(getEmptyStateMessage("all")).toContain("No music tracked yet");
  });

  it("returns scan alert messages for known error types", () => {
    expect(getCoverScanErrorMessage(new Error("uploadReleaseImage failed: 500"))).toContain(
      "Couldn't save the image",
    );
    expect(getCoverScanErrorMessage(new Error("scanCover failed: 503"))).toContain(
      "Scan unavailable",
    );
    expect(getCoverScanErrorMessage(new Error("other"))).toContain("Couldn't read the cover");
  });

  it("constrains image dimensions while preserving aspect ratio", () => {
    expect(constrainDimensions(500, 300, 1024)).toEqual({ width: 500, height: 300 });
    expect(constrainDimensions(2000, 1000, 1000)).toEqual({ width: 1000, height: 500 });
  });
});

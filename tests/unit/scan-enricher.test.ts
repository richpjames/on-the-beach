import { describe, expect, mock, test } from "bun:test";
import { createScanEnricher } from "../../server/scan-enricher";
import type { ScanResult } from "../../src/types";
import type { MusicBrainzFields } from "../../server/musicbrainz";

describe("createScanEnricher", () => {
  const mistralResult: ScanResult = { artist: "Radiohead", title: "OK Computer" };
  const mbFields: MusicBrainzFields = {
    year: 1997,
    label: "Parlophone",
    country: "GB",
    catalogueNumber: "CDPUSH45",
  };

  test("returns merged result when both Mistral and MusicBrainz succeed", async () => {
    const mockExtract = mock().mockResolvedValueOnce(mistralResult);
    const mockLookup = mock().mockResolvedValueOnce(mbFields);
    const enrich = createScanEnricher(mockExtract, mockLookup);

    const result = await enrich("base64data");
    expect(result).toEqual({
      artist: "Radiohead",
      title: "OK Computer",
      year: 1997,
      label: "Parlophone",
      country: "GB",
      catalogueNumber: "CDPUSH45",
    });
    expect(mockLookup).toHaveBeenCalledWith("Radiohead", "OK Computer");
  });

  test("returns Mistral-only result when MusicBrainz returns null", async () => {
    const mockExtract = mock().mockResolvedValueOnce(mistralResult);
    const mockLookup = mock().mockResolvedValueOnce(null);
    const enrich = createScanEnricher(mockExtract, mockLookup);

    const result = await enrich("base64data");
    expect(result).toEqual(mistralResult);
  });

  test("returns Mistral-only result when MusicBrainz throws", async () => {
    const mockExtract = mock().mockResolvedValueOnce(mistralResult);
    const mockLookup = mock().mockRejectedValueOnce(new Error("timeout"));
    const enrich = createScanEnricher(mockExtract, mockLookup);

    const result = await enrich("base64data");
    expect(result).toEqual(mistralResult);
  });

  test("returns null when Mistral returns null (does not call MusicBrainz)", async () => {
    const mockExtract = mock().mockResolvedValueOnce(null);
    const mockLookup = mock();
    const enrich = createScanEnricher(mockExtract, mockLookup);

    const result = await enrich("base64data");
    expect(result).toBeNull();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  test("skips MusicBrainz lookup when artist is null", async () => {
    const mockExtract = mock().mockResolvedValueOnce({ artist: null, title: "Unknown" });
    const mockLookup = mock();
    const enrich = createScanEnricher(mockExtract, mockLookup);

    const result = await enrich("base64data");
    expect(result).toEqual({ artist: null, title: "Unknown" });
    expect(mockLookup).not.toHaveBeenCalled();
  });

  test("skips MusicBrainz lookup when title is null", async () => {
    const mockExtract = mock().mockResolvedValueOnce({ artist: "Someone", title: null });
    const mockLookup = mock();
    const enrich = createScanEnricher(mockExtract, mockLookup);

    const result = await enrich("base64data");
    expect(result).toEqual({ artist: "Someone", title: null });
    expect(mockLookup).not.toHaveBeenCalled();
  });
});

import { describe, expect, mock, test } from "bun:test";
import { createScanEnricher } from "../../server/scan-enricher";
import type { ScanResult } from "../../src/types";
import type { MusicBrainzFields } from "../../server/musicbrainz";

describe("createScanEnricher", () => {
  const highConfidenceResult: ScanResult = {
    artist: "Radiohead",
    title: "OK Computer",
    confidence: 0.95,
  };
  const lowConfidenceResult: ScanResult = {
    artist: "Radiohead",
    title: "OK Computer",
    confidence: 0.5,
  };
  const mbFields: MusicBrainzFields = {
    year: 1997,
    label: "Parlophone",
    country: "GB",
    catalogueNumber: "CDPUSH45",
  };

  test("returns merged result when both Mistral and MusicBrainz succeed (high confidence)", async () => {
    const mockExtract = mock().mockResolvedValueOnce(highConfidenceResult);
    const mockLookup = mock().mockResolvedValueOnce(mbFields);
    const mockGetWebContext = mock();
    const mockExtractWithContext = mock();
    const enrich = createScanEnricher(
      mockExtract,
      mockLookup,
      mockGetWebContext,
      mockExtractWithContext,
    );

    const result = await enrich("base64data");
    expect(result).toEqual({
      artist: "Radiohead",
      title: "OK Computer",
      confidence: 0.95,
      year: 1997,
      label: "Parlophone",
      country: "GB",
      catalogueNumber: "CDPUSH45",
    });
    expect(mockLookup).toHaveBeenCalledWith("Radiohead", "OK Computer");
    expect(mockGetWebContext).not.toHaveBeenCalled();
  });

  test("skips web context when confidence >= 0.8", async () => {
    const mockExtract = mock().mockResolvedValueOnce(highConfidenceResult);
    const mockLookup = mock().mockResolvedValueOnce(null);
    const mockGetWebContext = mock();
    const mockExtractWithContext = mock();
    const enrich = createScanEnricher(
      mockExtract,
      mockLookup,
      mockGetWebContext,
      mockExtractWithContext,
    );

    await enrich("base64data");
    expect(mockGetWebContext).not.toHaveBeenCalled();
    expect(mockExtractWithContext).not.toHaveBeenCalled();
  });

  test("performs second pass when confidence < 0.8", async () => {
    const secondPassResult: ScanResult = {
      artist: "Radiohead",
      title: "OK Computer",
      confidence: 0.7,
    };
    const mockExtract = mock().mockResolvedValueOnce(lowConfidenceResult);
    const mockLookup = mock().mockResolvedValueOnce(null);
    const mockGetWebContext = mock().mockResolvedValueOnce(
      "Best guess labels: Radiohead OK Computer",
    );
    const mockExtractWithContext = mock().mockResolvedValueOnce(secondPassResult);
    const enrich = createScanEnricher(
      mockExtract,
      mockLookup,
      mockGetWebContext,
      mockExtractWithContext,
    );

    const result = await enrich("base64data");
    expect(mockGetWebContext).toHaveBeenCalledWith("base64data");
    expect(mockExtractWithContext).toHaveBeenCalledWith(
      "base64data",
      "Best guess labels: Radiohead OK Computer",
    );
    expect(result).toEqual(secondPassResult);
  });

  test("falls back to first pass result when web context is null", async () => {
    const mockExtract = mock().mockResolvedValueOnce(lowConfidenceResult);
    const mockLookup = mock().mockResolvedValueOnce(null);
    const mockGetWebContext = mock().mockResolvedValueOnce(null);
    const mockExtractWithContext = mock();
    const enrich = createScanEnricher(
      mockExtract,
      mockLookup,
      mockGetWebContext,
      mockExtractWithContext,
    );

    const result = await enrich("base64data");
    expect(mockExtractWithContext).not.toHaveBeenCalled();
    expect(result).toEqual(lowConfidenceResult);
  });

  test("falls back to first pass result when second pass returns null", async () => {
    const mockExtract = mock().mockResolvedValueOnce(lowConfidenceResult);
    const mockLookup = mock().mockResolvedValueOnce(null);
    const mockGetWebContext = mock().mockResolvedValueOnce("some context");
    const mockExtractWithContext = mock().mockResolvedValueOnce(null);
    const enrich = createScanEnricher(
      mockExtract,
      mockLookup,
      mockGetWebContext,
      mockExtractWithContext,
    );

    const result = await enrich("base64data");
    expect(result).toEqual(lowConfidenceResult);
  });

  test("returns Mistral-only result when MusicBrainz returns null", async () => {
    const mockExtract = mock().mockResolvedValueOnce(highConfidenceResult);
    const mockLookup = mock().mockResolvedValueOnce(null);
    const mockGetWebContext = mock();
    const mockExtractWithContext = mock();
    const enrich = createScanEnricher(
      mockExtract,
      mockLookup,
      mockGetWebContext,
      mockExtractWithContext,
    );

    const result = await enrich("base64data");
    expect(result).toEqual(highConfidenceResult);
  });

  test("returns Mistral-only result when MusicBrainz throws", async () => {
    const mockExtract = mock().mockResolvedValueOnce(highConfidenceResult);
    const mockLookup = mock().mockRejectedValueOnce(new Error("timeout"));
    const mockGetWebContext = mock();
    const mockExtractWithContext = mock();
    const enrich = createScanEnricher(
      mockExtract,
      mockLookup,
      mockGetWebContext,
      mockExtractWithContext,
    );

    const result = await enrich("base64data");
    expect(result).toEqual(highConfidenceResult);
  });

  test("returns null when Mistral returns null (does not call MusicBrainz)", async () => {
    const mockExtract = mock().mockResolvedValueOnce(null);
    const mockLookup = mock();
    const mockGetWebContext = mock();
    const mockExtractWithContext = mock();
    const enrich = createScanEnricher(
      mockExtract,
      mockLookup,
      mockGetWebContext,
      mockExtractWithContext,
    );

    const result = await enrich("base64data");
    expect(result).toBeNull();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  test("skips MusicBrainz lookup when artist is null", async () => {
    const noArtist: ScanResult = { artist: null, title: "Unknown", confidence: 0.9 };
    const mockExtract = mock().mockResolvedValueOnce(noArtist);
    const mockLookup = mock();
    const mockGetWebContext = mock();
    const mockExtractWithContext = mock();
    const enrich = createScanEnricher(
      mockExtract,
      mockLookup,
      mockGetWebContext,
      mockExtractWithContext,
    );

    const result = await enrich("base64data");
    expect(result).toEqual(noArtist);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  test("skips MusicBrainz lookup when title is null", async () => {
    const noTitle: ScanResult = { artist: "Someone", title: null, confidence: 0.9 };
    const mockExtract = mock().mockResolvedValueOnce(noTitle);
    const mockLookup = mock();
    const mockGetWebContext = mock();
    const mockExtractWithContext = mock();
    const enrich = createScanEnricher(
      mockExtract,
      mockLookup,
      mockGetWebContext,
      mockExtractWithContext,
    );

    const result = await enrich("base64data");
    expect(result).toEqual(noTitle);
    expect(mockLookup).not.toHaveBeenCalled();
  });
});

import { describe, expect, mock, spyOn, test } from "bun:test";
import { createScanEnricher } from "../../app/scan-enricher";
import type { ScanResult } from "../../domain/types";
import type { ResolutionOutcome } from "../../app/release-resolver";

function outcome(overrides: Partial<ResolutionOutcome> = {}): ResolutionOutcome {
  return { status: "matched", ids: null, errors: [], ...overrides };
}

const resolvedIds = {
  musicbrainzReleaseId: "mb-release-1",
  musicbrainzReleaseGroupId: "mb-group-1",
  musicbrainzArtistId: "mb-artist-1",
  discogsReleaseId: 12345,
  discogsMasterId: 6789,
  year: 1997,
  label: "Parlophone",
  country: "GB",
  catalogueNumber: "CDPUSH45",
  confidence: 0.93,
};

describe("createScanEnricher", () => {
  const highConfidenceResult: ScanResult = {
    artist: "Radiohead",
    title: "OK Computer",
    artistConfidence: 0.95,
    titleConfidence: 0.95,
  };
  const lowConfidenceResult: ScanResult = {
    artist: "Radiohead",
    title: "OK Computer",
    artistConfidence: 0.5,
    titleConfidence: 0.5,
  };

  test("returns merged result when both Mistral and the resolver succeed (high confidence)", async () => {
    const mockExtract = mock().mockResolvedValueOnce(highConfidenceResult);
    const mockResolve = mock().mockResolvedValueOnce(outcome({ ids: resolvedIds }));
    const mockGetWebContext = mock();
    const mockExtractWithContext = mock();
    const enrich = createScanEnricher(
      mockExtract,
      mockResolve,
      mockGetWebContext,
      mockExtractWithContext,
    );

    const result = await enrich("base64data");
    expect(result).toEqual({
      artist: "Radiohead",
      title: "OK Computer",
      artistConfidence: 0.95,
      titleConfidence: 0.95,
      year: 1997,
      label: "Parlophone",
      country: "GB",
      catalogueNumber: "CDPUSH45",
      musicbrainzReleaseId: "mb-release-1",
      musicbrainzReleaseGroupId: "mb-group-1",
      musicbrainzArtistId: "mb-artist-1",
      discogsReleaseId: 12345,
      discogsMasterId: 6789,
      resolutionStatus: "matched",
      resolutionConfidence: 0.93,
    });
    expect(mockResolve).toHaveBeenCalledWith({ artist: "Radiohead", title: "OK Computer" });
    expect(mockGetWebContext).not.toHaveBeenCalled();
  });

  test("skips web context when confidence >= 0.8", async () => {
    const mockExtract = mock().mockResolvedValueOnce(highConfidenceResult);
    const mockResolve = mock().mockResolvedValueOnce(outcome({ status: "absent" }));
    const mockGetWebContext = mock();
    const mockExtractWithContext = mock();
    const enrich = createScanEnricher(
      mockExtract,
      mockResolve,
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
      artistConfidence: 0.7,
      titleConfidence: 0.7,
    };
    const mockExtract = mock().mockResolvedValueOnce(lowConfidenceResult);
    const mockResolve = mock().mockResolvedValueOnce(outcome({ status: "absent" }));
    const mockGetWebContext = mock().mockResolvedValueOnce(
      "Best guess labels: Radiohead OK Computer",
    );
    const mockExtractWithContext = mock().mockResolvedValueOnce(secondPassResult);
    const enrich = createScanEnricher(
      mockExtract,
      mockResolve,
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
    const mockResolve = mock().mockResolvedValueOnce(outcome({ status: "absent" }));
    const mockGetWebContext = mock().mockResolvedValueOnce(null);
    const mockExtractWithContext = mock();
    const enrich = createScanEnricher(
      mockExtract,
      mockResolve,
      mockGetWebContext,
      mockExtractWithContext,
    );

    const result = await enrich("base64data");
    expect(mockExtractWithContext).not.toHaveBeenCalled();
    expect(result).toEqual(lowConfidenceResult);
  });

  test("falls back to first pass result when second pass returns null", async () => {
    const mockExtract = mock().mockResolvedValueOnce(lowConfidenceResult);
    const mockResolve = mock().mockResolvedValueOnce(outcome({ status: "absent" }));
    const mockGetWebContext = mock().mockResolvedValueOnce("some context");
    const mockExtractWithContext = mock().mockResolvedValueOnce(null);
    const enrich = createScanEnricher(
      mockExtract,
      mockResolve,
      mockGetWebContext,
      mockExtractWithContext,
    );

    const result = await enrich("base64data");
    expect(result).toEqual(lowConfidenceResult);
  });

  test("returns Mistral-only result when the resolver finds nothing", async () => {
    const mockExtract = mock().mockResolvedValueOnce(highConfidenceResult);
    const mockResolve = mock().mockResolvedValueOnce(outcome({ status: "absent" }));
    const mockGetWebContext = mock();
    const mockExtractWithContext = mock();
    const enrich = createScanEnricher(
      mockExtract,
      mockResolve,
      mockGetWebContext,
      mockExtractWithContext,
    );

    const result = await enrich("base64data");
    expect(result).toEqual(highConfidenceResult);
  });

  test("returns Mistral-only result when resolution failed (provider error)", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const mockExtract = mock().mockResolvedValueOnce(highConfidenceResult);
    const mockResolve = mock().mockResolvedValueOnce(
      outcome({
        status: "failed",
        errors: [{ provider: "musicbrainz", message: "503 Service Unavailable" }],
      }),
    );
    const mockGetWebContext = mock();
    const mockExtractWithContext = mock();
    const enrich = createScanEnricher(
      mockExtract,
      mockResolve,
      mockGetWebContext,
      mockExtractWithContext,
    );

    const result = await enrich("base64data");
    expect(result).toEqual(highConfidenceResult);
    expect(warnSpy).toHaveBeenCalledWith("scan enrichment: musicbrainz: 503 Service Unavailable");
    warnSpy.mockRestore();
  });

  test("returns Mistral-only result when the resolver throws", async () => {
    const mockExtract = mock().mockResolvedValueOnce(highConfidenceResult);
    const mockResolve = mock().mockRejectedValueOnce(new Error("timeout"));
    const mockGetWebContext = mock();
    const mockExtractWithContext = mock();
    const enrich = createScanEnricher(
      mockExtract,
      mockResolve,
      mockGetWebContext,
      mockExtractWithContext,
    );

    const result = await enrich("base64data");
    expect(result).toEqual(highConfidenceResult);
  });

  test("returns null when Mistral returns null (does not call the resolver)", async () => {
    const mockExtract = mock().mockResolvedValueOnce(null);
    const mockResolve = mock();
    const mockGetWebContext = mock();
    const mockExtractWithContext = mock();
    const enrich = createScanEnricher(
      mockExtract,
      mockResolve,
      mockGetWebContext,
      mockExtractWithContext,
    );

    const result = await enrich("base64data");
    expect(result).toBeNull();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  test("skips resolution when artist is null", async () => {
    const noArtist: ScanResult = {
      artist: null,
      title: "Unknown",
      artistConfidence: 0.9,
      titleConfidence: 0.9,
    };
    const mockExtract = mock().mockResolvedValueOnce(noArtist);
    const mockResolve = mock();
    const mockGetWebContext = mock();
    const mockExtractWithContext = mock();
    const enrich = createScanEnricher(
      mockExtract,
      mockResolve,
      mockGetWebContext,
      mockExtractWithContext,
    );

    const result = await enrich("base64data");
    expect(result).toEqual(noArtist);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  test("skips resolution when title is null", async () => {
    const noTitle: ScanResult = {
      artist: "Someone",
      title: null,
      artistConfidence: 0.9,
      titleConfidence: 0.9,
    };
    const mockExtract = mock().mockResolvedValueOnce(noTitle);
    const mockResolve = mock();
    const mockGetWebContext = mock();
    const mockExtractWithContext = mock();
    const enrich = createScanEnricher(
      mockExtract,
      mockResolve,
      mockGetWebContext,
      mockExtractWithContext,
    );

    const result = await enrich("base64data");
    expect(result).toEqual(noTitle);
    expect(mockResolve).not.toHaveBeenCalled();
  });
});

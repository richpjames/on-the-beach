import type { ScanResult } from "../domain/types";
import type { ReleaseQuery, ResolutionOutcome } from "./release-resolver";

const CONFIDENCE_THRESHOLD = 0.8;

type ExtractFn = (base64Image: string) => Promise<ScanResult | null>;
type ExtractWithContextFn = (base64Image: string, webContext: string) => Promise<ScanResult | null>;
type ResolveFn = (query: ReleaseQuery) => Promise<ResolutionOutcome>;
type GetWebContextFn = (base64Image: string) => Promise<string | null>;

async function enrichWithResolution(result: ScanResult, resolve: ResolveFn): Promise<ScanResult> {
  if (!result.artist || !result.title) {
    return result;
  }

  try {
    const outcome = await resolve({ artist: result.artist, title: result.title });
    if (!outcome.ids) {
      // "absent" means no verified release anywhere — leave the scan as the
      // vision read it, exactly like a null lookup did. "failed" is retryable,
      // but nothing retries at this seam, so it degrades the same way; the warn
      // keeps a throttled provider from looking like an unknown record.
      for (const error of outcome.errors) {
        console.warn(`scan enrichment: ${error.provider}: ${error.message}`);
      }
      return result;
    }

    const ids = outcome.ids;
    return {
      ...result,
      year: ids.year,
      label: ids.label,
      country: ids.country,
      catalogueNumber: ids.catalogueNumber,
      musicbrainzReleaseId: ids.musicbrainzReleaseId,
      musicbrainzReleaseGroupId: ids.musicbrainzReleaseGroupId,
      musicbrainzArtistId: ids.musicbrainzArtistId,
      discogsReleaseId: ids.discogsReleaseId,
      discogsMasterId: ids.discogsMasterId,
      resolutionStatus: outcome.status,
      resolutionConfidence: ids.confidence,
    };
  } catch {
    return result;
  }
}

export function createScanEnricher(
  extract: ExtractFn,
  resolve: ResolveFn,
  getWebContext: GetWebContextFn,
  extractWithContext: ExtractWithContextFn,
): (base64Image: string) => Promise<ScanResult | null> {
  return async (base64Image: string): Promise<ScanResult | null> => {
    const firstPass = await extract(base64Image);
    if (!firstPass) return null;

    if (
      firstPass.artistConfidence >= CONFIDENCE_THRESHOLD &&
      firstPass.titleConfidence >= CONFIDENCE_THRESHOLD
    ) {
      return enrichWithResolution(firstPass, resolve);
    }

    const webContext = await getWebContext(base64Image);
    if (!webContext) {
      return enrichWithResolution(firstPass, resolve);
    }

    const secondPass = await extractWithContext(base64Image, webContext);
    const result = secondPass ?? firstPass;

    return enrichWithResolution(result, resolve);
  };
}

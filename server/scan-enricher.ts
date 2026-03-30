import type { ScanResult } from "../src/types";
import type { MusicBrainzFields } from "./musicbrainz";

const CONFIDENCE_THRESHOLD = 0.8;

type ExtractFn = (base64Image: string) => Promise<ScanResult | null>;
type ExtractWithContextFn = (base64Image: string, webContext: string) => Promise<ScanResult | null>;
type LookupFn = (artist: string, title: string) => Promise<MusicBrainzFields | null>;
type GetWebContextFn = (base64Image: string) => Promise<string | null>;

async function enrichWithMusicBrainz(result: ScanResult, lookup: LookupFn): Promise<ScanResult> {
  if (!result.artist || !result.title) {
    return result;
  }

  try {
    const mbFields = await lookup(result.artist, result.title);
    if (!mbFields) return result;
    return { ...result, ...mbFields };
  } catch {
    return result;
  }
}

export function createScanEnricher(
  extract: ExtractFn,
  lookup: LookupFn,
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
      return enrichWithMusicBrainz(firstPass, lookup);
    }

    const webContext = await getWebContext(base64Image);
    if (!webContext) {
      return enrichWithMusicBrainz(firstPass, lookup);
    }

    const secondPass = await extractWithContext(base64Image, webContext);
    const result = secondPass ?? firstPass;

    return enrichWithMusicBrainz(result, lookup);
  };
}

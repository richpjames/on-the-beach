import type { ScanResult } from "../src/types";
import type { MusicBrainzFields } from "./musicbrainz";

type ExtractFn = (base64Image: string) => Promise<ScanResult | null>;
type LookupFn = (artist: string, title: string) => Promise<MusicBrainzFields | null>;

export function createScanEnricher(
  extract: ExtractFn,
  lookup: LookupFn,
): (base64Image: string) => Promise<ScanResult | null> {
  return async (base64Image: string): Promise<ScanResult | null> => {
    const mistralResult = await extract(base64Image);
    if (!mistralResult) return null;

    if (!mistralResult.artist || !mistralResult.title) {
      return mistralResult;
    }

    try {
      const mbFields = await lookup(mistralResult.artist, mistralResult.title);
      if (!mbFields) return mistralResult;
      return { ...mistralResult, ...mbFields };
    } catch {
      return mistralResult;
    }
  };
}

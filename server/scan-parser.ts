import type { ScanResult } from "../src/types";

export function parseScanJson(rawContent: string): ScanResult | null {
  const trimmed = rawContent.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonCandidate = fenced ? fenced[1].trim() : trimmed;

  try {
    const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const artist = typeof parsed.artist === "string" ? parsed.artist.trim() || null : null;
    const title = typeof parsed.title === "string" ? parsed.title.trim() || null : null;

    if (
      parsed.artist !== null &&
      parsed.artist !== undefined &&
      typeof parsed.artist !== "string"
    ) {
      return null;
    }

    if (parsed.title !== null && parsed.title !== undefined && typeof parsed.title !== "string") {
      return null;
    }

    return { artist, title };
  } catch {
    return null;
  }
}

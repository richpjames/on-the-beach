import type { ScanResult } from "../src/types";

function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.toLowerCase() === "null" ? null : trimmed;
}

export function parseScanJson(rawContent: string): ScanResult | null {
  const trimmed = rawContent.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonCandidate = fenced ? fenced[1].trim() : trimmed;

  try {
    const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const artist = normalizeNullableString(parsed.artist);
    const title = normalizeNullableString(parsed.title);

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

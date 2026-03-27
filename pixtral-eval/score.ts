export function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type MatchType = "exact" | "partial" | "none";

export interface ScoreResult {
  score: 0 | 1 | 2;
  match_type: MatchType;
}

export function scoreResult(
  parsed: { artist: string; title: string },
  ground: { artist: string; title: string },
): ScoreResult {
  const artistMatch = normalise(parsed.artist) === normalise(ground.artist);
  const titleMatch = normalise(parsed.title) === normalise(ground.title);

  if (artistMatch && titleMatch) return { score: 2, match_type: "exact" };
  if (artistMatch || titleMatch) return { score: 1, match_type: "partial" };
  return { score: 0, match_type: "none" };
}

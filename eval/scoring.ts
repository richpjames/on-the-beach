function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }

  return dp[m][n];
}

export function levenshteinSimilarity(a: string, b: string): number {
  const al = a.toLowerCase().trim();
  const bl = b.toLowerCase().trim();
  if (al.length === 0 && bl.length === 0) return 1.0;
  if (al.length === 0 || bl.length === 0) return 0.0;
  const dist = levenshteinDistance(al, bl);
  return 1 - dist / Math.max(al.length, bl.length);
}

export function scoreResult(
  actual: { artist: string | null; title: string | null },
  expected: { artist: string; title: string },
): { artistExact: number; titleExact: number; artistFuzzy: number; titleFuzzy: number } {
  const artistExact =
    actual.artist !== null &&
    actual.artist.toLowerCase().trim() === expected.artist.toLowerCase().trim()
      ? 1
      : 0;
  const titleExact =
    actual.title !== null &&
    actual.title.toLowerCase().trim() === expected.title.toLowerCase().trim()
      ? 1
      : 0;

  const artistFuzzy =
    actual.artist !== null ? levenshteinSimilarity(actual.artist, expected.artist) : 0;
  const titleFuzzy =
    actual.title !== null ? levenshteinSimilarity(actual.title, expected.title) : 0;

  return { artistExact, titleExact, artistFuzzy, titleFuzzy };
}

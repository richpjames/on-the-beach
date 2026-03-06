export type PrimaryFeedKey = "all" | "to-listen" | "listened";

export const PRIMARY_FEEDS: Array<{ key: PrimaryFeedKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "to-listen", label: "To Listen" },
  { key: "listened", label: "Listened" },
];

export function buildPrimaryFeedHref(feed: PrimaryFeedKey): string {
  return `/feed/${feed}.rss`;
}

export function buildPrimaryFeedTitle(feed: PrimaryFeedKey): string {
  const label = PRIMARY_FEEDS.find((candidate) => candidate.key === feed)?.label ?? feed;
  return `${label} RSS feed`;
}

export function buildStackFeedHref(stackId: number): string {
  return `/feed/stacks/${stackId}.rss`;
}

export function buildStackFeedTitle(stackName: string): string {
  return `${stackName} RSS feed`;
}

export type PrimaryFeedKey = "all" | "to-listen" | "listened";
export const PRIMARY_FEEDS: Array<{ key: PrimaryFeedKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "to-listen", label: "To Listen" },
  { key: "listened", label: "Listened" },
];

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

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

export function renderPrimaryFeedAlternateLinks(): string {
  return PRIMARY_FEEDS.map(
    (feed) =>
      `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(buildPrimaryFeedTitle(feed.key))}" href="${escapeHtml(buildPrimaryFeedHref(feed.key))}" />`,
  ).join("\n    ");
}

export function renderStackFeedAlternateLinks(stacks: Array<{ id: number; name: string }>): string {
  return stacks
    .map(
      (stack) =>
        `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(buildStackFeedTitle(stack.name))}" href="${escapeHtml(buildStackFeedHref(stack.id))}" data-rss-feed-link="${stack.id}" />`,
    )
    .join("\n    ");
}

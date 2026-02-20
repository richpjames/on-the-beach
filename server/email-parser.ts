import { parseUrl } from "./utils";

export interface EmailContent {
  html?: string;
  text?: string;
}

/**
 * Extract music platform URLs from an email's HTML or plain-text body.
 *
 * Strategy:
 *  1. Pull all href values from <a> tags in the HTML body
 *  2. If no HTML or no hrefs found, fall back to bare URL extraction from text
 *  3. Run each URL through parseUrl() and keep only known music sources
 *  4. Deduplicate by normalised URL
 */
export function extractMusicUrls(email: EmailContent): string[] {
  const rawUrls: string[] = [];

  // Extract from HTML <a href="..."> tags
  if (email.html) {
    const hrefRegex = /href=["']([^"']+)["']/gi;
    let match;
    while ((match = hrefRegex.exec(email.html)) !== null) {
      rawUrls.push(match[1]);
    }
  }

  // Fallback: extract bare URLs from plain text
  if (rawUrls.length === 0 && email.text) {
    const urlRegex = /https?:\/\/[^\s<>"']+/gi;
    let match;
    while ((match = urlRegex.exec(email.text)) !== null) {
      rawUrls.push(match[0]);
    }
  }

  // Filter to known music platform URLs and deduplicate
  const seen = new Set<string>();
  const musicUrls: string[] = [];

  for (const url of rawUrls) {
    const parsed = parseUrl(url);
    if (parsed.source === "unknown") continue;

    const normalized = parsed.normalizedUrl;
    if (seen.has(normalized)) continue;

    seen.add(normalized);
    musicUrls.push(normalized);
  }

  return musicUrls;
}

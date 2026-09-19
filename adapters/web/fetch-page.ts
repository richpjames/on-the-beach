/**
 * Fetching a page's HTML with a timeout, for adapters that read pages.
 *
 * Every source reads pages the same way — a UA-bearing fetch under an abort
 * timer, stopped at `</head>` or `</body>` before the whole document arrives —
 * so the mechanics live here once. What a source does with the HTML is that
 * source's business.
 */

/** Enough for any `<head>`, OG tags included. */
export const MAX_HEAD_BYTES = 100_000;

/** Enough for Bandcamp's `TralbumData` and SoundCloud's hydra state in a body. */
export const MAX_BODY_BYTES = 250_000;

export interface FetchPageOptions {
  /** Read no more than this many bytes of HTML. */
  maxBytes: number;
  /** Stop once this marker has been seen (`"</head>"` or `"</body>"`). */
  stopAt: "</head>" | "</body>";
}

/**
 * The page's HTML, read up to `stopAt` or `maxBytes` — whichever comes first.
 *
 * Returns null when the page isn't reachable HTML: a non-HTML content type, a
 * missing body or a fetch that fails or times out. Callers with their own
 * fallback (an oEmbed answer, an API lookup) apply it on null.
 */
export async function fetchPageHtml(
  url: string,
  timeoutMs: number,
  { maxBytes, stopAt }: FetchPageOptions,
): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MusicBot/1.0)",
        Accept: "text/html",
      },
    });

    clearTimeout(timer);

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return null;

    // Read only the head for known sources, but include part of the body for unknown pages.
    const reader = response.body?.getReader();
    if (!reader) return null;

    let html = "";
    const decoder = new TextDecoder();
    while (html.length < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (html.includes(stopAt)) break;
    }

    reader.cancel();

    return html;
  } catch {
    return null;
  }
}

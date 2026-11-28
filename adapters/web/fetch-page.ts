/**
 * Fetching a page's HTML with a timeout, for adapters that read pages.
 *
 * Every source reads pages the same way — a UA-bearing fetch under an abort
 * timer, stopped at `</head>` or `</body>` before the whole document arrives —
 * so the mechanics live here once. What a source does with the HTML is that
 * source's business.
 */

import { lookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { Readable } from "node:stream";
import { isPublicIpAddress } from "../../domain/ip-address";

/** Enough for any `<head>`, OG tags included. */
export const MAX_HEAD_BYTES = 100_000;

/** Enough for Bandcamp's `TralbumData` and SoundCloud's hydra state in a body. */
export const MAX_BODY_BYTES = 250_000;

/**
 * Enough for a review page's article body. Pitchfork's review prose starts
 * around a third of a megabyte into the document — well past `MAX_BODY_BYTES`
 * — so notes enrichment reads further than the metadata scrapes do.
 */
export const MAX_REVIEW_BYTES = 1_500_000;

export interface FetchPageOptions {
  /** Read no more than this many bytes of HTML. */
  maxBytes: number;
  /** Stop once this marker has been seen (`"</head>"` or `"</body>"`). */
  stopAt: "</head>" | "</body>";
  /**
   * Refuse any host — or redirect hop — that resolves to a non-public
   * address. For pages whose URL a third party chose (MusicBrainz url-rels
   * are editable by anyone): a public-looking name can answer with loopback
   * or a private address, and a redirect can aim the fetch there too.
   */
  publicHostsOnly?: boolean;
}

const PAGE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; MusicBot/1.0)",
  Accept: "text/html",
};

/** Redirect hops followed under `publicHostsOnly` before giving up. */
const MAX_PUBLIC_REDIRECTS = 5;

/**
 * Settle a promise against an abort signal. Bun's `lookup` ignores the signal
 * option, so the resolver is raced against the same timeout the fetch runs
 * under: a hostname whose server drops queries can no longer stall the
 * request past its budget (the abandoned query still finishes in the
 * threadpool, but nothing waits on it).
 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Connect to the vetted addresses, never re-resolving the name. The hostname
 * still sets Host and SNI, but the custom `lookup` hands the socket exactly
 * the addresses the gate approved — so a rebinding name (TTL 0, alternating
 * answers) cannot answer public for the check and loopback for the connection.
 * The node response is wrapped as a web Response so the reader downstream is
 * the same one the plain fetch uses.
 */
function pinnedRequest(
  parsed: URL,
  hostname: string,
  addresses: { address: string; family: number }[],
  signal: AbortSignal,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const transport = parsed.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        hostname,
        port: parsed.port ? Number(parsed.port) : undefined,
        path: parsed.pathname + parsed.search,
        method: "GET",
        // node:http does not negotiate or undo content compression the way
        // fetch does; ask for plain text so the body reads as HTML.
        headers: { ...PAGE_HEADERS, "Accept-Encoding": "identity" },
        lookup: (_host, _options, callback) => callback(null, addresses),
      } as http.RequestOptions,
      (res) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) for (const item of value) headers.append(name, item);
          else headers.append(name, value);
        }
        resolve(
          new Response(Readable.toWeb(res) as unknown as ReadableStream, {
            status: res.statusCode,
            headers,
          }),
        );
      },
    );
    req.on("error", reject);
    const onAbort = () => req.destroy(new Error("aborted"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    req.end();
  });
}

/**
 * Fetch with every hop checked against the resolver and pinned to the answer:
 * the name must resolve to public addresses only, the connection uses exactly
 * those addresses, and each redirect is re-checked and re-pinned the same way
 * before it is followed. A refusal throws — the caller settles it as a miss.
 */
async function fetchPublicPage(url: string, signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop++) {
    const parsed = new URL(current);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`refusing non-http(s) URL: ${current}`);
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
    // Resolve before connecting. An IP literal answers with itself; a name
    // answers with every address it has — one private answer is enough to
    // refuse, since the connection could pick any of them.
    const addresses = await abortable(lookup(hostname, { all: true, verbatim: true }), signal);
    if (addresses.length === 0 || addresses.some((a) => !isPublicIpAddress(a.address))) {
      throw new Error(`refusing non-public address for ${hostname}`);
    }
    const response = await pinnedRequest(parsed, hostname, addresses, signal);
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      if (hop >= MAX_PUBLIC_REDIRECTS) throw new Error("too many redirects");
      current = new URL(location, current).toString();
      continue;
    }
    return response;
  }
}

/**
 * The page's HTML, read up to `stopAt` or `maxBytes` — whichever comes first.
 *
 * Returns null when the page isn't reachable HTML: a non-2xx answer, a
 * non-HTML content type, a missing body or a fetch that fails or times out.
 * A blocked page's error body is not the page — reading it as HTML is how a
 * marketplace's 403 "Error Page" came to be judged "not music-related".
 * Callers with their own fallback (an oEmbed answer, an API lookup) apply it
 * on null.
 */
export async function fetchPageHtml(
  url: string,
  timeoutMs: number,
  { maxBytes, stopAt, publicHostsOnly = false }: FetchPageOptions,
): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = publicHostsOnly
        ? await fetchPublicPage(url, controller.signal)
        : await fetch(url, { signal: controller.signal, headers: PAGE_HEADERS });
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }

    clearTimeout(timer);

    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }

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

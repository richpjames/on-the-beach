import { Mistral } from "@mistralai/mistralai";
import type { ItemType, LinkReleaseCandidate } from "../domain/types";
import { decodeHtmlEntities } from "./html-metadata";

const DEFAULT_LINK_MODEL = "mistral-small-latest";
const MAX_AI_TEXT_CHARS = 20_000;

const WEB_RELEASE_PROMPT =
  "You are extracting music release data from a web page snippet. " +
  "Respond with JSON only using this shape: " +
  '{"releases":[{"artist":"string|null","title":"string|null","itemType":"album|ep|single|track|mix|compilation|null","confidence":"number|null","evidence":"string|null","isPrimary":"boolean|null"}]}. ' +
  "Return every distinct music release clearly described in the snippet. " +
  "Mark isPrimary true only when the page is mainly about that one release, such as a product page or dedicated release page. " +
  "Use evidence for a short reason like 'product title', 'headline', or 'release section'. " +
  "If a release is self-titled or has no distinct title, use the artist name as the title. " +
  "Do not invent releases. Return an empty releases array when the snippet is music-related but no concrete release can be extracted.";

interface TextChunkLike {
  type?: unknown;
  text?: unknown;
}

export interface ExtractedReleaseCandidate {
  candidateId: string;
  artist?: string;
  title?: string;
  itemType?: ItemType;
  confidence?: number;
  evidence?: string;
  isPrimary?: boolean;
  /** The release's own page, when the scraped page linked to it — see `matchReleaseUrls`. */
  url?: string;
}

function slugifySegment(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function buildCandidateId(artist: string | undefined, title: string, index: number): string {
  const artistPart = slugifySegment(artist) || "unknown-artist";
  const titlePart = slugifySegment(title) || "unknown-title";
  return `cand-${index + 1}-${artistPart}-${titlePart}`;
}

function contentToText(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const text = content
    .map((chunk): string => {
      if (!chunk || typeof chunk !== "object") return "";
      const textChunk = chunk as TextChunkLike;
      if (textChunk.type !== "text" || typeof textChunk.text !== "string") {
        return "";
      }
      return textChunk.text;
    })
    .filter(Boolean)
    .join("\n")
    .trim();

  return text.length > 0 ? text : null;
}

function normalizeNullableString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") {
    return undefined;
  }

  return decodeHtmlEntities(trimmed);
}

function normalizeItemType(value: unknown): ItemType | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  switch (value.trim().toLowerCase()) {
    case "album":
      return "album";
    case "ep":
      return "ep";
    case "single":
      return "single";
    case "track":
      return "track";
    case "mix":
    case "mixtape":
      return "mix";
    case "compilation":
      return "compilation";
    default:
      return undefined;
  }
}

function normalizeConfidence(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(0, Math.min(1, value));
}

function parseReleaseCandidate(value: unknown, index: number): ExtractedReleaseCandidate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const artist = normalizeNullableString(candidate.artist);
  const title = normalizeNullableString(candidate.title) ?? artist;
  const itemType = normalizeItemType(candidate.itemType);
  const evidence = normalizeNullableString(candidate.evidence);
  const confidence = normalizeConfidence(candidate.confidence);
  const isPrimary = typeof candidate.isPrimary === "boolean" ? candidate.isPrimary : undefined;

  if (!title) {
    return null;
  }

  return {
    candidateId: buildCandidateId(artist, title, index),
    ...(artist ? { artist } : {}),
    title,
    ...(itemType ? { itemType } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(evidence ? { evidence } : {}),
    ...(isPrimary !== undefined ? { isPrimary } : {}),
  };
}

export function parseReleaseCandidatesJson(rawContent: string): ExtractedReleaseCandidate[] {
  const trimmed = rawContent.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonCandidate = fenced ? fenced[1].trim() : trimmed;

  try {
    const parsed = JSON.parse(jsonCandidate) as unknown;
    const root =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;

    if (!root) {
      return [];
    }

    const releases = Array.isArray(root.releases) ? root.releases : [];
    const seen = new Set<string>();
    const normalized: ExtractedReleaseCandidate[] = [];

    for (const [index, release] of releases.entries()) {
      const candidate = parseReleaseCandidate(release, index);
      if (!candidate) {
        continue;
      }

      const dedupeKey = `${candidate.artist?.toLowerCase() ?? ""}::${candidate.title?.toLowerCase() ?? ""}`;
      if (seen.has(dedupeKey)) {
        continue;
      }

      seen.add(dedupeKey);
      normalized.push(candidate);
    }

    return normalized;
  } catch {
    return [];
  }
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function scoreUrlMatch(urlText: string, candidate: LinkReleaseCandidate): number {
  let score = 0;
  const title = normalizeSearchText(candidate.title);
  const artist = normalizeSearchText(candidate.artist ?? "");

  if (title && urlText.includes(title)) {
    score += 2.5;
  }

  if (artist && urlText.includes(artist)) {
    score += 1.5;
  }

  const titleWords = title.split(" ").filter((word) => word.length >= 4);
  const matchingTitleWords = titleWords.filter((word) => urlText.includes(word));
  score += Math.min(matchingTitleWords.length * 0.35, 1.4);

  return score;
}

export function pickPrimaryReleaseCandidate(
  url: string,
  candidates: LinkReleaseCandidate[],
): LinkReleaseCandidate | null {
  if (candidates.length === 1) {
    return candidates[0];
  }

  let urlText = "";
  try {
    const parsed = new URL(url);
    urlText = normalizeSearchText(`${parsed.hostname} ${parsed.pathname}`);
  } catch {
    urlText = normalizeSearchText(url);
  }

  const scored = candidates
    .map((candidate) => {
      let score = scoreUrlMatch(urlText, candidate);
      if (candidate.isPrimary) {
        score += 3;
      }
      if (candidate.confidence !== undefined) {
        score += candidate.confidence;
      }
      return { candidate, score };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];
  if (!best) {
    return null;
  }

  const scoreGap = second ? best.score - second.score : best.score;
  const hasStrongUrlSignal = scoreUrlMatch(urlText, best.candidate) >= 2.5;
  const hasExplicitPrimarySignal = best.candidate.isPrimary === true;

  if ((hasStrongUrlSignal || hasExplicitPrimarySignal) && scoreGap >= 1.25) {
    return best.candidate;
  }

  return null;
}

export async function extractReleaseCandidatesFromWebText(
  url: string,
  pageText: string,
): Promise<ExtractedReleaseCandidate[] | null> {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    return null;
  }

  const snippet = pageText.trim().slice(0, MAX_AI_TEXT_CHARS);
  if (!snippet) {
    return [];
  }

  const client = new Mistral({ apiKey });
  const model = process.env.MISTRAL_LINK_MODEL?.trim() || DEFAULT_LINK_MODEL;

  try {
    const response = await client.chat.complete({
      model,
      temperature: 0,
      responseFormat: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `${WEB_RELEASE_PROMPT}\n\nURL: ${url}\n\nSnippet:\n${snippet}`,
            },
          ],
        },
      ],
    });

    const message = response.choices[0]?.message?.content;
    const textContent = contentToText(message);
    if (!textContent) {
      console.error("[scraper] Mistral link extraction returned no text content");
      return [];
    }

    return parseReleaseCandidatesJson(textContent);
  } catch (err) {
    console.error("[scraper] Mistral link extraction failed:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Per-release links
// ---------------------------------------------------------------------------

/** A link found on a scraped page, with whatever text pointed at it. */
export interface PageLink {
  url: string;
  /** Anchor text, image alt, title/aria-label — every label seen for this URL. */
  texts: string[];
}

const ANCHOR_PATTERN = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
const IMG_ALT_PATTERN = /<img\b[^>]*?\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const MIN_RELEASE_URL_SCORE = 2.5;
/** How far the best link must beat the runner-up before it counts as the one. */
const MIN_RELEASE_URL_GAP = 0.5;

/**
 * One attribute off a tag's attribute list. The name has to start the
 * attribute, or `data-href` would answer for `href`.
 */
function readAttribute(attrs: string, name: string): string | undefined {
  const match = attrs.match(
    new RegExp(`(?:^|[\\s/])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"),
  );
  if (!match) return undefined;
  return match[1] ?? match[2] ?? match[3];
}

function anchorTexts(attrs: string, inner: string): string[] {
  const texts: string[] = [];

  const visible = decodeHtmlEntities(inner.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  if (visible) texts.push(visible);

  for (const alt of inner.matchAll(IMG_ALT_PATTERN)) {
    const value = decodeHtmlEntities(alt[1] ?? alt[2] ?? "").trim();
    if (value) texts.push(value);
  }

  for (const name of ["title", "aria-label"]) {
    const value = readAttribute(attrs, name);
    if (value) texts.push(decodeHtmlEntities(value).trim());
  }

  return texts.filter(Boolean);
}

/**
 * A key that treats the same page reached two ways — trailing slash or not,
 * host cased differently — as one link, so a listing page's artwork and title
 * anchors collapse into a single entry.
 */
function linkKey(url: URL): string {
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.hostname.toLowerCase()}${path}${url.search}`;
}

/**
 * Every outbound link on a page, keyed by destination. Used to give each
 * release lifted off a listing page a link to its own page rather than to the
 * listing.
 */
export function extractPageLinks(html: string, pageUrl: string): PageLink[] {
  let pageKey: string | null = null;
  try {
    pageKey = linkKey(new URL(pageUrl));
  } catch {
    pageKey = null;
  }

  const byKey = new Map<string, PageLink>();

  for (const anchor of html.matchAll(ANCHOR_PATTERN)) {
    const attrs = anchor[1] ?? "";
    const href = readAttribute(attrs, "href");
    if (!href) continue;

    let resolved: URL;
    try {
      resolved = new URL(decodeHtmlEntities(href), pageUrl);
    } catch {
      continue;
    }

    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
    resolved.hash = "";

    const key = linkKey(resolved);
    // The page itself, and bare site roots, say nothing about one release.
    if (!key || key === pageKey || !resolved.pathname.replace(/\/+$/, "")) continue;

    const existing = byKey.get(key);
    const texts = anchorTexts(attrs, anchor[2] ?? "");
    if (existing) {
      for (const text of texts) {
        if (!existing.texts.includes(text)) existing.texts.push(text);
      }
      continue;
    }

    byKey.set(key, { url: resolved.toString(), texts });
  }

  return [...byKey.values()];
}

/**
 * Where a link actually goes, ignoring the query. Mixcloud links a show's page
 * once per comment on it (`?commentId=…`); those are one destination, and
 * counting them as rivals would leave every such release unmatched.
 */
function destinationKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}

/** The link's own path, read as words: "/dj/cabo-verde-drett/" → "dj cabo verde drett". */
function linkSlugText(url: string): string {
  try {
    return normalizeSearchText(decodeURIComponent(new URL(url).pathname));
  } catch {
    return normalizeSearchText(url);
  }
}

/**
 * How much of a title's substance shows up in some text, ignoring the short
 * words a coincidence would turn up. Titles with fewer than two such words
 * score nothing — "Onze" appearing somewhere is no evidence at all.
 */
function wordOverlapRatio(title: string, text: string): number {
  const words = [...new Set(title.split(" ").filter((word) => word.length >= 4))];
  if (words.length < 2) return 0;

  const hits = words.filter((word) => text.includes(word)).length;
  return hits / words.length;
}

function scoreTextMatch(title: string, artist: string, text: string, exactScore: number): number {
  if (!text) return 0;

  let score: number;
  if (text === title) {
    score = exactScore;
  } else if (title.length >= 6 && text.includes(title)) {
    score = exactScore - 1;
  } else if (text.length >= 6 && title.includes(text)) {
    score = exactScore - 1.5;
  } else {
    score = wordOverlapRatio(title, text) * (exactScore - 1.5);
  }

  if (score > 0 && artist && text.includes(artist)) score += 0.5;
  return score;
}

function scoreLinkForCandidate(link: PageLink, candidate: ExtractedReleaseCandidate): number {
  const title = normalizeSearchText(candidate.title ?? "");
  if (!title) return 0;

  const artist = normalizeSearchText(candidate.artist ?? "");
  let best = scoreTextMatch(title, artist, linkSlugText(link.url), 4);

  for (const text of link.texts) {
    best = Math.max(best, scoreTextMatch(title, artist, normalizeSearchText(text), 4));
  }

  return best;
}

/**
 * Point each release at its own page.
 *
 * A page listing several releases — a Mixcloud profile, a label's catalogue, a
 * round-up — links to each of them, so an item lifted off it should link to the
 * release rather than back to the listing. Matches on the link's text and its
 * slug, and leaves a release's URL unset rather than guess: an unmatched
 * release still gets the page it came from, which is where it came from.
 */
export function matchReleaseUrls(
  candidates: ExtractedReleaseCandidate[],
  links: PageLink[],
): ExtractedReleaseCandidate[] {
  if (links.length === 0) return candidates;

  const bestByUrl = new Map<string, { index: number; score: number }>();
  const matched = new Map<number, string>();

  candidates.forEach((candidate, index) => {
    const ranked = links
      .map((link) => ({ link, score: scoreLinkForCandidate(link, candidate) }))
      // Equal scores go to the plainer URL — the show's page, not the same page
      // with a comment pinned.
      .sort((a, b) => b.score - a.score || a.link.url.length - b.link.url.length);

    const seen = new Set<string>();
    const scored = ranked.filter((entry) => {
      const key = destinationKey(entry.link.url);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const best = scored[0];
    if (!best || best.score < MIN_RELEASE_URL_SCORE) return;

    // Two links fitting equally well means the page didn't say which is the
    // release's own — better the listing URL than the wrong mix.
    const runnerUp = scored[1]?.score ?? 0;
    if (best.score - runnerUp < MIN_RELEASE_URL_GAP) return;

    // One link can only be one release's: keep the release that fits it best.
    const claimed = bestByUrl.get(best.link.url);
    if (claimed) {
      if (claimed.score >= best.score) return;
      matched.delete(claimed.index);
    }

    bestByUrl.set(best.link.url, { index, score: best.score });
    matched.set(index, best.link.url);
  });

  return candidates.map((candidate, index) => {
    const url = matched.get(index);
    return url ? { ...candidate, url } : candidate;
  });
}

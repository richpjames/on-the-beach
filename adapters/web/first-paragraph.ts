import { decodeHtmlEntities } from "./html-metadata";

// ---------------------------------------------------------------------------
// The first paragraph of a page's prose, for notes enrichment.
//
// Each known host keeps its article body in a different wrapper, and the
// paragraphs before it are furniture — Pitchfork's score boxes, Wikipedia's
// hatnotes and empty template shells. Scope to the wrapper first, then take
// the first paragraph that strips to real text. An unknown host gets the
// whole document and a minimum length, so a navigation fragment doesn't read
// as prose. Scripts, styles and comments go first — their text can carry
// paragraph markup of its own — then consent notices and site chrome are
// stripped before the pick, and a paragraph that reads as a cookie banner is
// skipped even though it is sentence-shaped.
// ---------------------------------------------------------------------------

/** Where each known host's article body starts, as an HTML fragment to find. */
const SITE_SCOPES: Record<string, string> = {
  "wikipedia.org": 'class="mw-parser-output"',
  "pitchfork.com": 'class="body__inner-container"',
  // AllMusic answers bots with a 403 more often than not; when it does answer,
  // the review lives here. Best-effort — a fetch failure degrades to no note.
  "allmusic.com": 'class="review"',
};

/** Below this, an unscoped paragraph is more likely furniture than prose. */
const MIN_GENERIC_PARAGRAPH_CHARS = 40;

/**
 * Page chrome and consent banners are furniture, not prose: a cookie notice
 * is usually the first paragraph-shaped thing in an unscoped document. Strip
 * the containers before picking. Best-effort — a banner whose nested markup
 * escapes the block match is still caught by `isConsentBoilerplate` below.
 * (JavaScript-injected consent managers never arrive at all: the fetch reads
 * static HTML.)
 *
 * The end anchor matters on hostile markup: without it, every unclosed
 * opener costs a full lazy scan of the remaining text, so a page of unclosed
 * `<nav>`s is quadratic — minutes of synchronous regex on the one event
 * loop. With it, an unclosed container is stripped to the end in one pass,
 * as a browser would read it, and the whole read stays linear.
 */
const CHROME_BLOCKS = /<(header|footer|nav|aside|dialog)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi;
const CONSENT_BLOCKS =
  /<(div|section)\b[^>]*(cookie|consent|gdpr|onetrust|cookiebot|quantcast|truste|didomi|sp_message|cmp-)[^>]*>[\s\S]*?(?:<\/\1>|$)/gi;

/**
 * Whether a paragraph reads as a consent notice rather than prose about the
 * record. Cookie banners are sentences, so the sentence gate alone accepts
 * them; but they nearly always name cookies or consent alongside what the
 * site does with them, or tell the reader what continuing implies — phrasing
 * an album paragraph has no business carrying.
 */
export function isConsentBoilerplate(text: string): boolean {
  if (
    /\b(cookies?|consent|gdpr)\b/i.test(text) &&
    /\b(use|uses|using|accept|accepting|agree|policy|policies|preferences|settings|help|ensure|deliver|store|collect)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  return /privacy (policy|notice|statement)|your privacy|by (continuing|clicking|using (this|our))/i.test(
    text,
  );
}

/** Strip a fragment to its text: no scripts, styles, citations or tags. */
function htmlToText(fragment: string): string {
  // End-anchored like the document-level cleaning: an unclosed block (the
  // byte cap can cut mid-tag) goes to the end in one pass, never a rescan
  // per opener on a fragment full of unclosed tags.
  const withoutBlocks = fragment
    .replace(/<script\b[\s\S]*?(?:<\/script>|$)/gi, "")
    .replace(/<style\b[\s\S]*?(?:<\/style>|$)/gi, "")
    // Wikipedia's citation markers — [1] is not part of the sentence.
    .replace(/<sup\b[\s\S]*?(?:<\/sup>|$)/gi, "")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  // Line and block breaks become spaces before the tags go, or words on
  // either side of a <br> or a block boundary would glue together
  // ("Foo<br>bar" → "Foobar"). The later whitespace collapse keeps it tidy.
  const withoutTags = withoutBlocks
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?(?:p|div|li|h[1-6]|blockquote|hr)\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "");
  return decodeHtmlEntities(withoutTags)
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The picked paragraph, and whether it came from the host's article wrapper.
 * A curated host whose wrapper has vanished (a markup change, an AMP variant,
 * an interstitial) falls back to the whole document; the caller uses `scoped`
 * to decide whether that fallback may be trusted without further checks.
 */
export type ExtractedParagraph = { text: string; scoped: boolean };

/**
 * The first paragraph of prose in the page, or null when none survives the
 * cleaning. `host` is the bare source key (see domain/link-sources.ts) — it
 * picks the wrapper to scope to, not the URL's own hostname.
 */
export function extractFirstParagraph(html: string, host: string): ExtractedParagraph | null {
  // Scripts, styles and comments are not prose, and their text can carry
  // `<p>` markup (ad snippets, hydration payloads) that would otherwise win
  // the paragraph match — or fake the scope marker. Remove them before
  // anything else reads the document. An unclosed block (the byte cap can
  // cut mid-script) is stripped to the end, as a browser would read it.
  const cleaned = html
    .replace(/<script\b[\s\S]*?(?:<\/script>|$)/gi, " ")
    .replace(/<style\b[\s\S]*?(?:<\/style>|$)/gi, " ")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ");

  const scope = SITE_SCOPES[host];
  const scopeAt = scope ? cleaned.indexOf(scope) : -1;
  const scoped = scopeAt >= 0;
  const body = (scoped ? cleaned.slice(scopeAt) : cleaned)
    .replace(CHROME_BLOCKS, "")
    .replace(CONSENT_BLOCKS, "");
  const minChars = scoped ? 1 : MIN_GENERIC_PARAGRAPH_CHARS;

  // A `<p>` may be closed implicitly by the next `<p>`, so matching to the
  // first `</p>` can swallow several paragraphs — and the markup between
  // them — into one blob. Split at every opener instead: each chunk is one
  // paragraph's own content, up to its explicit close; the next opener has
  // already ended it, and anything after the close is inter-paragraph
  // furniture, not part of the pick.
  const chunks = body.split(/<p\b[^>]*>/i).slice(1);
  for (const chunk of chunks) {
    const text = htmlToText(chunk.split(/<\/p>/i)[0]!);
    if (text.length >= minChars && !isConsentBoilerplate(text)) return { text, scoped };
  }
  return null;
}

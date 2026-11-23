import { decodeHtmlEntities } from "./html-metadata";

// ---------------------------------------------------------------------------
// The first paragraph of a page's prose, for notes enrichment.
//
// Each known host keeps its article body in a different wrapper, and the
// paragraphs before it are furniture — Pitchfork's score boxes, Wikipedia's
// hatnotes and empty template shells. Scope to the wrapper first, then take
// the first paragraph that strips to real text. An unknown host gets the
// whole document and a minimum length, so a navigation fragment doesn't read
// as prose.
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

/** Strip a fragment to its text: no scripts, styles, citations or tags. */
function htmlToText(fragment: string): string {
  const withoutBlocks = fragment
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    // Wikipedia's citation markers — [1] is not part of the sentence.
    .replace(/<sup\b[\s\S]*?<\/sup>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const withoutTags = withoutBlocks.replace(/<[^>]+>/g, "");
  return decodeHtmlEntities(withoutTags)
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The first paragraph of prose in the page, or null when none survives the
 * cleaning. `host` is the bare source key (see domain/link-sources.ts) — it
 * picks the wrapper to scope to, not the URL's own hostname.
 */
export function extractFirstParagraph(html: string, host: string): string | null {
  const scope = SITE_SCOPES[host];
  const scoped = scope ? html.indexOf(scope) : -1;
  const body = scoped >= 0 ? html.slice(scoped) : html;
  const minChars = scoped >= 0 ? 1 : MIN_GENERIC_PARAGRAPH_CHARS;

  const paragraphs = body.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) ?? [];
  for (const paragraph of paragraphs) {
    const text = htmlToText(paragraph);
    if (text.length >= minChars) return text;
  }
  return null;
}

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { extractFirstParagraph } from "../../adapters/web/first-paragraph";

// The two fixtures are trimmed from the real pages (see the backfill plan):
// Pitchfork's review prose starts a third of a megabyte into the document,
// behind score furniture; Wikipedia's lead hides behind hatnotes, empty
// template shells and the infobox.

describe("extractFirstParagraph — Pitchfork", () => {
  const fixture = readFileSync(
    new URL("../fixtures/pitchfork-in-rainbows.html", import.meta.url),
    "utf8",
  );

  test("the lead paragraph of the review body, not the score furniture", () => {
    const paragraph = extractFirstParagraph(fixture, "pitchfork.com")!;
    expect(paragraph.scoped).toBe(true);
    expect(paragraph.text).toStartWith("Like many music lovers of a certain age");
    expect(paragraph.text).toContain("hitting play.");
    expect(paragraph.text).not.toContain("Reader Score");
  });

  test("entities are decoded and tags stripped", () => {
    const paragraph = extractFirstParagraph(fixture, "pitchfork.com")!;
    expect(paragraph.text).toContain("can't remember");
    expect(paragraph.text).not.toContain("<");
    expect(paragraph.text).not.toContain("&#x27;");
  });
});

describe("extractFirstParagraph — Wikipedia", () => {
  const fixture = readFileSync(
    new URL("../fixtures/wikipedia-in-rainbows.html", import.meta.url),
    "utf8",
  );

  test("the lead paragraph, past the hatnote and empty template shells", () => {
    const paragraph = extractFirstParagraph(fixture, "wikipedia.org")!;
    expect(paragraph.scoped).toBe(true);
    expect(paragraph.text).toStartWith("In Rainbows is the seventh studio album");
    expect(paragraph.text).toContain("by the English rock band Radiohead.");
    expect(paragraph.text).not.toContain("For the video album, see");
  });

  test("citation markers and wiki link markup are stripped", () => {
    const html =
      '<div class="mw-parser-output">' +
      '<p>Some claim.<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup></p>' +
      "</div>";
    expect(extractFirstParagraph(html, "wikipedia.org")?.text).toBe("Some claim.");
  });
});

describe("extractFirstParagraph — cleaning and scoping rules", () => {
  test("script and style contents never read as prose", () => {
    const html =
      "<style>.x{color:red}</style><script>var a = 1;</script>" +
      '<div class="review"><p>The actual review text.</p></div>';
    expect(extractFirstParagraph(html, "allmusic.com")?.text).toBe("The actual review text.");
  });

  test("empty paragraphs are skipped for the first real one", () => {
    const html =
      '<div class="mw-parser-output">' +
      '<p class="mw-empty-elt"><span></span></p>' +
      "<p>   </p>" +
      "<p>The lead.</p>" +
      "</div>";
    expect(extractFirstParagraph(html, "wikipedia.org")?.text).toBe("The lead.");
  });

  test("paragraphs before the scoped wrapper are ignored", () => {
    const html =
      "<p>Navigation furniture that is quite long enough to pass as prose.</p>" +
      '<div class="body__inner-container"><p>The review itself.</p></div>';
    expect(extractFirstParagraph(html, "pitchfork.com")?.text).toBe("The review itself.");
  });

  test("an unknown host reads the whole document, skipping short fragments", () => {
    const html =
      "<p>Menu</p><p>A paragraph of prose long enough to clear the bar for an unknown source.</p>";
    expect(extractFirstParagraph(html, "theguardian.com")?.text).toBe(
      "A paragraph of prose long enough to clear the bar for an unknown source.",
    );
  });

  test("a page with no usable paragraph returns null", () => {
    expect(extractFirstParagraph("<div><p></p></div>", "pitchfork.com")).toBeNull();
    expect(extractFirstParagraph("<html><body><h1>Title</h1></body></html>", "x.com")).toBeNull();
  });

  test("a known host whose wrapper is missing falls back to the whole document", () => {
    const html =
      "<p>A paragraph of prose long enough to clear the bar when the wrapper is absent.</p>";
    expect(extractFirstParagraph(html, "allmusic.com")).toEqual({
      text: "A paragraph of prose long enough to clear the bar when the wrapper is absent.",
      scoped: false,
    });
  });

  test("the unscoped fallback keeps the minimum length even for a known host", () => {
    expect(extractFirstParagraph("<p>Too short.</p>", "allmusic.com")).toBeNull();
  });

  test("a scoped pick reports scoped; a fallback or unknown host does not", () => {
    const scopedHtml = '<div class="review"><p>The actual review text.</p></div>';
    expect(extractFirstParagraph(scopedHtml, "allmusic.com")).toEqual({
      text: "The actual review text.",
      scoped: true,
    });
    const prose = "A paragraph of prose long enough to clear the bar for an unknown source.";
    expect(extractFirstParagraph(`<p>${prose}</p>`, "theguardian.com")?.scoped).toBe(false);
  });

  test("whitespace collapses to single spaces", () => {
    const html = '<div class="review"><p>One\n  line\twith   gaps.</p></div>';
    expect(extractFirstParagraph(html, "allmusic.com")?.text).toBe("One line with gaps.");
  });

  test("line and block breaks separate words instead of gluing them", () => {
    const breaks = '<div class="review"><p>Foo<br>bar<br/>baz</p></div>';
    expect(extractFirstParagraph(breaks, "allmusic.com")?.text).toBe("Foo bar baz");
    const blocks = '<div class="review"><p>One<div>two</div>three</p></div>';
    expect(extractFirstParagraph(blocks, "allmusic.com")?.text).toBe("One two three");
  });
});

describe("extractFirstParagraph — script, style and comment markup", () => {
  const PROSE = "A paragraph of prose long enough to clear the bar for an unknown source.";

  test("an inline script carrying paragraph markup never supplies the pick", () => {
    const html =
      '<script>var ad = "<p>Buy our stuff now, long enough to pass the bar.</p>";</script>' +
      `<p>${PROSE}</p>`;
    expect(extractFirstParagraph(html, "theguardian.com")?.text).toBe(PROSE);
  });

  test("a hydration payload in the head is not prose", () => {
    const html =
      '<head><script type="application/ld+json">' +
      '{"text":"<p>A hydration payload paragraph long enough to pass.</p>"}' +
      `</script></head><body><p>${PROSE}</p></body>`;
    expect(extractFirstParagraph(html, "theguardian.com")?.text).toBe(PROSE);
  });

  test("style and comment blocks carrying paragraph markup are stripped too", () => {
    const style =
      '<style>.x{content:"<p>Style template prose long enough to pass.</p>"}</style>' +
      `<p>${PROSE}</p>`;
    expect(extractFirstParagraph(style, "theguardian.com")?.text).toBe(PROSE);
    const comment =
      "<!-- <p>A commented-out paragraph long enough to pass the bar.</p> -->" + `<p>${PROSE}</p>`;
    expect(extractFirstParagraph(comment, "theguardian.com")?.text).toBe(PROSE);
  });

  test("a script cut off by the byte cap is stripped to the end", () => {
    // The read can stop mid-script; everything after an unclosed <script>
    // is script text, not prose.
    const html = `<p>${PROSE}</p><script>var x = "<p>Truncated payload paragraph.</p>`;
    expect(extractFirstParagraph(html, "theguardian.com")?.text).toBe(PROSE);
    expect(
      extractFirstParagraph('<script>var x = "<p>Only payload, no prose.</p>', "theguardian.com"),
    ).toBeNull();
  });

  test("a scope marker inside a script does not make the page scoped", () => {
    const html = `<script>var t = 'class="mw-parser-output"';</script><p>${PROSE}</p>`;
    expect(extractFirstParagraph(html, "wikipedia.org")).toEqual({ text: PROSE, scoped: false });
  });

  test("a real wrapper after a script still scopes the pick", () => {
    const html = '<script>var a = 1;</script><div class="mw-parser-output"><p>The lead.</p></div>';
    expect(extractFirstParagraph(html, "wikipedia.org")).toEqual({
      text: "The lead.",
      scoped: true,
    });
  });
});

describe("extractFirstParagraph — consent and chrome furniture", () => {
  const PROSE = "A paragraph of prose long enough to clear the bar for an unknown source.";

  test("a server-rendered cookie banner container is stripped", () => {
    const html =
      '<div id="cookie-banner"><div class="inner">' +
      "<p>We use cookies to ensure you get the best experience on our website.</p>" +
      "</div></div>" +
      `<p>${PROSE}</p>`;
    expect(extractFirstParagraph(html, "theguardian.com")?.text).toBe(PROSE);
  });

  test("a banner whose nested markup escapes the block match is caught by its text", () => {
    const html =
      '<div class="cookie-consent"><div>x</div>' +
      "<p>This site uses cookies to deliver our services.</p></div>" +
      `<p>${PROSE}</p>`;
    expect(extractFirstParagraph(html, "theguardian.com")?.text).toBe(PROSE);
  });

  test("a bare consent paragraph with no wrapper is skipped", () => {
    const html =
      "<p>We use cookies. By continuing to browse you accept our privacy policy.</p>" +
      `<p>${PROSE}</p>`;
    expect(extractFirstParagraph(html, "theguardian.com")?.text).toBe(PROSE);
  });

  test("a privacy notice without the word cookies is still boilerplate", () => {
    const html =
      "<p>We value your privacy and collect data to improve our services.</p>" + `<p>${PROSE}</p>`;
    expect(extractFirstParagraph(html, "theguardian.com")?.text).toBe(PROSE);
  });

  test("site chrome never supplies the paragraph", () => {
    const html =
      "<header><p>The site tagline, long enough to clear the bar for an unknown source.</p></header>" +
      "<nav><p>Menu items and navigation fragments long enough to pass the bar.</p></nav>" +
      `<p>${PROSE}</p>`;
    expect(extractFirstParagraph(html, "theguardian.com")?.text).toBe(PROSE);
  });

  test("prose that merely mentions cookies is still prose", () => {
    const html =
      "<p>The band handed out cookies at the gate, a joke that became the album's title.</p>";
    expect(extractFirstParagraph(html, "theguardian.com")?.text).toBe(
      "The band handed out cookies at the gate, a joke that became the album's title.",
    );
  });
});

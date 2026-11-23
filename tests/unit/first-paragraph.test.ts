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
    const paragraph = extractFirstParagraph(fixture, "pitchfork.com");
    expect(paragraph).toStartWith("Like many music lovers of a certain age");
    expect(paragraph).toContain("hitting play.");
    expect(paragraph).not.toContain("Reader Score");
  });

  test("entities are decoded and tags stripped", () => {
    const paragraph = extractFirstParagraph(fixture, "pitchfork.com")!;
    expect(paragraph).toContain("can't remember");
    expect(paragraph).not.toContain("<");
    expect(paragraph).not.toContain("&#x27;");
  });
});

describe("extractFirstParagraph — Wikipedia", () => {
  const fixture = readFileSync(
    new URL("../fixtures/wikipedia-in-rainbows.html", import.meta.url),
    "utf8",
  );

  test("the lead paragraph, past the hatnote and empty template shells", () => {
    const paragraph = extractFirstParagraph(fixture, "wikipedia.org");
    expect(paragraph).toStartWith("In Rainbows is the seventh studio album");
    expect(paragraph).toContain("by the English rock band Radiohead.");
    expect(paragraph).not.toContain("For the video album, see");
  });

  test("citation markers and wiki link markup are stripped", () => {
    const html =
      '<div class="mw-parser-output">' +
      '<p>Some claim.<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup></p>' +
      "</div>";
    expect(extractFirstParagraph(html, "wikipedia.org")).toBe("Some claim.");
  });
});

describe("extractFirstParagraph — cleaning and scoping rules", () => {
  test("script and style contents never read as prose", () => {
    const html =
      "<style>.x{color:red}</style><script>var a = 1;</script>" +
      '<div class="review"><p>The actual review text.</p></div>';
    expect(extractFirstParagraph(html, "allmusic.com")).toBe("The actual review text.");
  });

  test("empty paragraphs are skipped for the first real one", () => {
    const html =
      '<div class="mw-parser-output">' +
      '<p class="mw-empty-elt"><span></span></p>' +
      "<p>   </p>" +
      "<p>The lead.</p>" +
      "</div>";
    expect(extractFirstParagraph(html, "wikipedia.org")).toBe("The lead.");
  });

  test("paragraphs before the scoped wrapper are ignored", () => {
    const html =
      "<p>Navigation furniture that is quite long enough to pass as prose.</p>" +
      '<div class="body__inner-container"><p>The review itself.</p></div>';
    expect(extractFirstParagraph(html, "pitchfork.com")).toBe("The review itself.");
  });

  test("an unknown host reads the whole document, skipping short fragments", () => {
    const html =
      "<p>Menu</p><p>A paragraph of prose long enough to clear the bar for an unknown source.</p>";
    expect(extractFirstParagraph(html, "theguardian.com")).toBe(
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
    expect(extractFirstParagraph(html, "allmusic.com")).toBe(
      "A paragraph of prose long enough to clear the bar when the wrapper is absent.",
    );
  });

  test("whitespace collapses to single spaces", () => {
    const html = '<div class="review"><p>One\n  line\twith   gaps.</p></div>';
    expect(extractFirstParagraph(html, "allmusic.com")).toBe("One line with gaps.");
  });
});

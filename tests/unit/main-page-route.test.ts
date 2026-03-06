import { describe, expect, test } from "bun:test";
import { renderPrimaryFeedAlternateLinks, renderStackFeedAlternateLinks } from "../../shared/rss";

describe("renderPrimaryFeedAlternateLinks", () => {
  test("renders alternate RSS links for the main filters", () => {
    const html = renderPrimaryFeedAlternateLinks();

    expect(html).toContain('href="/feed/all.rss"');
    expect(html).toContain('href="/feed/to-listen.rss"');
    expect(html).toContain('href="/feed/listened.rss"');
    expect(html).toContain('title="All RSS feed"');
    expect(html).toContain('title="To Listen RSS feed"');
    expect(html).toContain('title="Listened RSS feed"');
  });
});

describe("renderStackFeedAlternateLinks", () => {
  test("renders one alternate RSS link per stack", () => {
    const html = renderStackFeedAlternateLinks([
      { id: 7, name: "Ambient" },
      { id: 9, name: "Dub Techno" },
    ]);

    expect(html).toContain('rel="alternate"');
    expect(html).toContain('type="application/rss+xml"');
    expect(html).toContain('href="/feed/stacks/7.rss"');
    expect(html).toContain('href="/feed/stacks/9.rss"');
    expect(html).toContain('title="Ambient RSS feed"');
    expect(html).toContain('title="Dub Techno RSS feed"');
    expect(html).toContain('data-rss-feed-link="7"');
    expect(html).toContain('data-rss-feed-link="9"');
  });

  test("escapes stack names in link titles", () => {
    const html = renderStackFeedAlternateLinks([{ id: 3, name: 'A&B "<test>"' }]);

    expect(html).toContain('title="A&amp;B &quot;&lt;test&gt;&quot; RSS feed"');
  });
});

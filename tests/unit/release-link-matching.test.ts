import { describe, expect, test } from "bun:test";
import {
  extractPageLinks,
  matchReleaseUrls,
  type ExtractedReleaseCandidate,
} from "../../server/link-extractor";

function candidate(
  title: string,
  artist?: string,
  index = 0,
): ExtractedReleaseCandidate & { title: string } {
  return { candidateId: `cand-${index + 1}`, title, ...(artist ? { artist } : {}) };
}

/** A Mixcloud profile page: one card per show, artwork and title both linked. */
const MIXCLOUD_PROFILE_HTML = `
  <html>
    <head><meta property="og:title" content="Comodo Varan"></head>
    <body>
      <a href="/comodovaran3/">Comodo Varan</a>
      <div class="card">
        <a href="/comodovaran3/cabo-verde-dansa-drett/"><img alt="CABO VERDE : DANSA DRETT&#x27;"></a>
        <a href="/comodovaran3/cabo-verde-dansa-drett/">CABO VERDE : DANSA DRETT&#x27;</a>
      </div>
      <div class="card">
        <a href="/comodovaran3/cabo-verde-sempre-funana/">CABO VERDE : SEMPRE FUNANÁ</a>
      </div>
      <div class="card">
        <a href="/comodovaran3/fidjus-di-badjo/">FIDJUS DI BADJO</a>
      </div>
      <a href="/comodovaran3/favorites/">Favorites</a>
    </body>
  </html>
`;

describe("extractPageLinks", () => {
  test("resolves relative links and collapses the anchors pointing at one page", () => {
    const links = extractPageLinks(MIXCLOUD_PROFILE_HTML, "https://www.mixcloud.com/comodovaran3/");

    const show = links.find((link) => link.url.endsWith("/cabo-verde-dansa-drett/"));
    expect(show?.url).toBe("https://www.mixcloud.com/comodovaran3/cabo-verde-dansa-drett/");
    expect(show?.texts).toContain("CABO VERDE : DANSA DRETT'");

    // The artwork anchor and the title anchor are one link, not two.
    expect(links.filter((link) => link.url.endsWith("/cabo-verde-dansa-drett/"))).toHaveLength(1);
  });

  test("drops the page's own URL, site roots and non-http schemes", () => {
    const links = extractPageLinks(
      `<a href="https://shop.example/">Home</a>
       <a href="https://shop.example/best-of">This page</a>
       <a href="mailto:hi@shop.example">Mail</a>
       <a href="/records/tagwerk">Tagwerk</a>`,
      "https://shop.example/best-of/",
    );

    expect(links.map((link) => link.url)).toEqual(["https://shop.example/records/tagwerk"]);
  });

  test("does not mistake a data- attribute for the href", () => {
    const links = extractPageLinks(
      `<a data-href="/tracking/pixel" href="/records/tagwerk">Tagwerk</a>`,
      "https://label.example/news",
    );

    expect(links.map((link) => link.url)).toEqual(["https://label.example/records/tagwerk"]);
  });

  test("reads a link's label from image alt and aria-label too", () => {
    const links = extractPageLinks(
      `<a href="/x" aria-label="Onze by Rue Basse"><img alt="Onze cover"></a>`,
      "https://label.example/",
    );

    expect(links[0]!.texts).toEqual(["Onze cover", "Onze by Rue Basse"]);
  });
});

describe("matchReleaseUrls", () => {
  test("gives each show picked off a Mixcloud profile its own link", () => {
    const links = extractPageLinks(MIXCLOUD_PROFILE_HTML, "https://www.mixcloud.com/comodovaran3/");
    const matched = matchReleaseUrls(
      [
        candidate("CABO VERDE : DANSA DRETT'", "Comodo Varan", 0),
        candidate("CABO VERDE : SEMPRE FUNANÁ", "Comodo Varan", 1),
        candidate("FIDJUS DI BADJO", "Comodo Varan", 2),
      ],
      links,
    );

    expect(matched.map((release) => release.url)).toEqual([
      "https://www.mixcloud.com/comodovaran3/cabo-verde-dansa-drett/",
      "https://www.mixcloud.com/comodovaran3/cabo-verde-sempre-funana/",
      "https://www.mixcloud.com/comodovaran3/fidjus-di-badjo/",
    ]);
  });

  test("matches on the link's slug when the anchor carries no text", () => {
    const links = extractPageLinks(
      `<a href="https://kalte.bandcamp.com/album/nachtfahrt-im-winter"><img></a>`,
      "https://roundup.example/best-of",
    );

    const [matched] = matchReleaseUrls([candidate("Nachtfahrt im Winter", "Kalte Sterne")], links);
    expect(matched!.url).toBe("https://kalte.bandcamp.com/album/nachtfahrt-im-winter");
  });

  test("leaves a release unmatched rather than guess between equally good links", () => {
    const links = extractPageLinks(
      `<a href="/a/onze-deluxe-edition">Onze</a><a href="/b/onze-original">Onze</a>`,
      "https://label.example/news",
    );

    const [matched] = matchReleaseUrls([candidate("Onze", "Rue Basse")], links);
    expect(matched!.url).toBeUndefined();
  });

  test("leaves a release unmatched when nothing on the page is about it", () => {
    const links = extractPageLinks(
      `<a href="/about">About us</a><a href="/newsletter">Newsletter signup</a>`,
      "https://label.example/news",
    );

    const [matched] = matchReleaseUrls([candidate("Slow Tide", "Ninth Hour")], links);
    expect(matched!.url).toBeUndefined();
  });

  test("gives a link to the release that fits it best, not to both", () => {
    const links = extractPageLinks(
      `<a href="/releases/tagwerk-remixes">Tagwerk Remixes</a>`,
      "https://label.example/news",
    );

    const matched = matchReleaseUrls(
      [
        candidate("Tagwerk Remixes", "Halbe Zeit", 0),
        candidate("Tagwerk Remixes", "Halbe Zeit", 1),
      ],
      links,
    );

    expect(matched[0]!.url).toBe("https://label.example/releases/tagwerk-remixes");
    expect(matched[1]!.url).toBeUndefined();
  });
});

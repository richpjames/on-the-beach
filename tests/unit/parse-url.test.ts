import { describe, test, expect } from "bun:test";
import { parseUrl, marketplaceListingKey, sourceIsMarketplace } from "../../adapters/registry";
import { extractYouTubePlaylistId } from "../../adapters/youtube/index";

describe("parseUrl - youtube", () => {
  test("identifies youtube watch link and preserves video ID in normalizedUrl", () => {
    const result = parseUrl("https://www.youtube.com/watch?v=C9CkvAQkQLs");

    expect(result.source).toBe("youtube");
    expect(result.normalizedUrl).toBe("https://www.youtube.com/watch?v=C9CkvAQkQLs");
  });

  test("normalizes youtu.be shortlinks to full watch URL", () => {
    const result = parseUrl("https://youtu.be/C9CkvAQkQLs");

    expect(result.source).toBe("youtube");
    expect(result.normalizedUrl).toBe("https://www.youtube.com/watch?v=C9CkvAQkQLs");
  });

  test("normalizes mobile m.youtube.com links to full watch URL", () => {
    const result = parseUrl("https://m.youtube.com/watch?v=C9CkvAQkQLs");

    expect(result.source).toBe("youtube");
    expect(result.normalizedUrl).toBe("https://www.youtube.com/watch?v=C9CkvAQkQLs");
  });

  test("identifies youtube playlist link", () => {
    const result = parseUrl("https://www.youtube.com/playlist?list=PLE31AAD9114F343C4");

    expect(result.source).toBe("youtube");
    expect(result.normalizedUrl).toBe("https://www.youtube.com/playlist?list=PLE31AAD9114F343C4");
  });

  test("normalizes youtube playlist link by stripping extra params", () => {
    const result = parseUrl("https://www.youtube.com/playlist?list=PLE31AAD9114F343C4&si=abc123");

    expect(result.source).toBe("youtube");
    expect(result.normalizedUrl).toBe("https://www.youtube.com/playlist?list=PLE31AAD9114F343C4");
  });
});

describe("extractYouTubePlaylistId", () => {
  test("extracts playlist ID from standard playlist URL", () => {
    expect(
      extractYouTubePlaylistId("https://www.youtube.com/playlist?list=PLE31AAD9114F343C4"),
    ).toBe("PLE31AAD9114F343C4");
  });

  test("returns null for a video watch URL", () => {
    expect(extractYouTubePlaylistId("https://www.youtube.com/watch?v=C9CkvAQkQLs")).toBeNull();
  });

  test("returns null for non-youtube URLs", () => {
    expect(extractYouTubePlaylistId("https://soundcloud.com/artist/track")).toBeNull();
  });
});

describe("parseUrl - soundcloud", () => {
  test("identifies soundcloud track link", () => {
    const result = parseUrl("https://soundcloud.com/mike-omara/spring26");

    expect(result.source).toBe("soundcloud");
    expect(result.potentialArtist).toBe("mike omara");
    expect(result.potentialTitle).toBe("spring26");
  });

  test("identifies mobile m.soundcloud.com links and strips the m. prefix", () => {
    const result = parseUrl(
      "https://m.soundcloud.com/mike-omara/spring26?ref=clipboard&p=a&c=1&si=2500729ecc264ec5a83ce9e92e4fe0ca&utm_source=clipboard&utm_medium=text&utm_campaign=social_sharing",
    );

    expect(result.source).toBe("soundcloud");
    expect(result.potentialArtist).toBe("mike omara");
    expect(result.potentialTitle).toBe("spring26");
    expect(result.normalizedUrl).toBe("https://soundcloud.com/mike-omara/spring26");
  });
});

describe("parseUrl - discogs", () => {
  test("identifies a marketplace listing on the legacy /sell/item path", () => {
    const result = parseUrl("https://www.discogs.com/sell/item/4334240712");

    expect(result.source).toBe("discogs");
    expect(result.normalizedUrl).toBe("https://www.discogs.com/sell/item/4334240712");
  });

  test("identifies a marketplace listing on the current /shop/item path", () => {
    const result = parseUrl("https://www.discogs.com/shop/item/4334240712");

    expect(result.source).toBe("discogs");
  });

  test("normalises /shop/item to /sell/item so both spellings dedupe together", () => {
    const shop = parseUrl("https://www.discogs.com/shop/item/4334240712?ev=item_sug");
    const sell = parseUrl("https://www.discogs.com/sell/item/4334240712");

    expect(shop.normalizedUrl).toBe(sell.normalizedUrl);
    expect(shop.normalizedUrl).toBe("https://www.discogs.com/sell/item/4334240712");
  });

  test("leaves a release URL and its slug untouched", () => {
    const result = parseUrl("https://www.discogs.com/release/123456-Neil-Young-On-The-Beach?ev=x");

    expect(result.source).toBe("discogs");
    expect(result.normalizedUrl).toBe(
      "https://www.discogs.com/release/123456-Neil-Young-On-The-Beach",
    );
  });
});

describe("parseUrl - generic mobile subdomain handling", () => {
  test("strips m. from mixcloud links", () => {
    const result = parseUrl("https://m.mixcloud.com/somebody/some-show/");

    expect(result.source).toBe("mixcloud");
    expect(result.normalizedUrl).toBe("https://mixcloud.com/somebody/some-show/");
  });

  test("strips m. from discogs links", () => {
    const result = parseUrl("https://m.discogs.com/release/123456");

    expect(result.source).toBe("discogs");
    expect(result.normalizedUrl).toBe("https://discogs.com/release/123456");
  });
});

describe("parseUrl - nts", () => {
  test("identifies NTS episode link", () => {
    const result = parseUrl(
      "https://www.nts.live/shows/tropic-of-cancer/episodes/tropic-of-cancer-6th-march-2026",
    );

    expect(result.source).toBe("nts");
  });

  test("strips query params from normalized URL", () => {
    const result = parseUrl(
      "https://www.nts.live/shows/tropic-of-cancer/episodes/tropic-of-cancer-6th-march-2026?some=param",
    );

    expect(result.normalizedUrl).toBe(
      "https://www.nts.live/shows/tropic-of-cancer/episodes/tropic-of-cancer-6th-march-2026",
    );
  });

  test("extracts show slug as potentialArtist", () => {
    const result = parseUrl(
      "https://www.nts.live/shows/tropic-of-cancer/episodes/tropic-of-cancer-6th-march-2026",
    );

    expect(result.potentialArtist).toBe("tropic of cancer");
  });

  test("extracts episode slug as potentialTitle", () => {
    const result = parseUrl(
      "https://www.nts.live/shows/tropic-of-cancer/episodes/tropic-of-cancer-6th-march-2026",
    );

    expect(result.potentialTitle).toBe("tropic of cancer 6th march 2026");
  });

  test("identifies NTS show index page (no episode)", () => {
    const result = parseUrl("https://www.nts.live/shows/tropic-of-cancer");

    expect(result.source).toBe("nts");
    expect(result.potentialArtist).toBe("tropic of cancer");
  });

  test("matches nts.live URLs without www prefix", () => {
    const result = parseUrl(
      "https://nts.live/shows/tropic-of-cancer/episodes/tropic-of-cancer-6th-march-2026",
    );

    expect(result.source).toBe("nts");
  });
});

describe("parseUrl - pitchfork", () => {
  test("identifies a Pitchfork album review URL", () => {
    const result = parseUrl(
      "https://pitchfork.com/reviews/albums/mahito-yokota-koji-kondo-super-mario-galaxy-super-mario-galaxy-2/",
    );

    expect(result.source).toBe("pitchfork");
    expect(result.normalizedUrl).toBe(
      "https://pitchfork.com/reviews/albums/mahito-yokota-koji-kondo-super-mario-galaxy-super-mario-galaxy-2/",
    );
  });

  test("does not extract artist or title from the slug (ambiguous)", () => {
    const result = parseUrl(
      "https://pitchfork.com/reviews/albums/mahito-yokota-koji-kondo-super-mario-galaxy-super-mario-galaxy-2/",
    );

    expect(result.potentialArtist).toBeUndefined();
    expect(result.potentialTitle).toBeUndefined();
  });

  test("matches www.pitchfork.com hosts and strips query params", () => {
    const result = parseUrl(
      "https://www.pitchfork.com/reviews/albums/some-artist-some-album/?utm_source=twitter",
    );

    expect(result.source).toBe("pitchfork");
    expect(result.normalizedUrl).toBe(
      "https://www.pitchfork.com/reviews/albums/some-artist-some-album/",
    );
  });
});

describe("parseUrl - apple music", () => {
  test("identifies apple music release link and extracts title", () => {
    const result = parseUrl("https://music.apple.com/es/album/el-poder-verde/1810282984?l=en-GB");

    expect(result.source).toBe("apple_music");
    expect(result.potentialTitle).toBe("el poder verde");
  });

  test("strips query params from normalized URL", () => {
    const result = parseUrl("https://music.apple.com/es/album/el-poder-verde/1810282984?l=en-GB");

    expect(result.normalizedUrl).toBe("https://music.apple.com/es/album/el-poder-verde/1810282984");
  });

  test("extracts title from playlist link", () => {
    const result = parseUrl(
      "https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb",
    );

    expect(result.source).toBe("apple_music");
    expect(result.potentialTitle).toBe("todays hits");
  });

  test("identifies artist link and extracts artist name", () => {
    const result = parseUrl("https://music.apple.com/us/artist/the-beatles/136975");

    expect(result.source).toBe("apple_music");
    expect(result.potentialArtist).toBe("the beatles");
  });

  test("identifies music video link and extracts title", () => {
    const result = parseUrl("https://music.apple.com/us/music-video/bad-guy/1461695557");

    expect(result.source).toBe("apple_music");
    expect(result.potentialTitle).toBe("bad guy");
  });

  test("identifies station link", () => {
    const result = parseUrl("https://music.apple.com/us/station/pure-dance/ra.978194965");

    expect(result.source).toBe("apple_music");
  });
});

describe("parseUrl - qobuz", () => {
  test("identifies a store album link and strips query params", () => {
    const result = parseUrl(
      "https://www.qobuz.com/us-en/album/kind-of-blue-miles-davis/5099749522428?utm_source=share",
    );

    expect(result.source).toBe("qobuz");
    expect(result.normalizedUrl).toBe(
      "https://www.qobuz.com/us-en/album/kind-of-blue-miles-davis/5099749522428",
    );
  });

  test("does not extract artist or title from an album slug (ambiguous)", () => {
    const result = parseUrl(
      "https://www.qobuz.com/fr-fr/album/kind-of-blue-miles-davis/5099749522428",
    );

    expect(result.potentialArtist).toBeUndefined();
    expect(result.potentialTitle).toBeUndefined();
  });

  test("identifies track and playlist links", () => {
    expect(parseUrl("https://www.qobuz.com/gb-en/track/so-what-miles-davis/13176083").source).toBe(
      "qobuz",
    );
    expect(parseUrl("https://www.qobuz.com/us-en/playlist/lucinda-williams/4458346").source).toBe(
      "qobuz",
    );
  });

  test("identifies an interpreter link and extracts the artist slug", () => {
    const result = parseUrl("https://www.qobuz.com/us-en/interpreter/miles-davis/6760");

    expect(result.source).toBe("qobuz");
    expect(result.potentialArtist).toBe("miles davis");
  });

  test("identifies player share links", () => {
    const result = parseUrl("https://play.qobuz.com/album/5099749522428");

    expect(result.source).toBe("qobuz");
    expect(result.normalizedUrl).toBe("https://play.qobuz.com/album/5099749522428");
    expect(parseUrl("https://play.qobuz.com/track/13176083").source).toBe("qobuz");
    expect(parseUrl("https://play.qobuz.com/playlist/4458346").source).toBe("qobuz");
  });

  test("accepts the newer opaque album ids", () => {
    const result = parseUrl(
      "https://www.qobuz.com/us-en/album/some-record-some-artist/g0xt6qab8z8lb",
    );

    expect(result.source).toBe("qobuz");
  });

  test("a qobuz page that names no resource we model is unknown", () => {
    expect(parseUrl("https://www.qobuz.com/us-en/label/columbia/4592").source).toBe("unknown");
    expect(parseUrl("https://www.qobuz.com/us-en/album/").source).toBe("unknown");
    expect(parseUrl("https://qobuz.com.evil.test/album/x/123").source).toBe("unknown");
  });
});

describe("parseUrl - ebay", () => {
  test("identifies a listing on a country site and keeps its TLD", () => {
    const result = parseUrl("https://www.ebay.es/itm/800867457219?itmprp=cks%3A123");

    expect(result.source).toBe("ebay");
    expect(result.normalizedUrl).toBe("https://www.ebay.es/itm/800867457219");
    expect(result.listingId).toBe("800867457219");
  });

  test("accepts a title slug before the listing id", () => {
    const result = parseUrl("https://www.ebay.com/itm/Thomas-Leer-Contradictions-LP/800867457219");

    expect(result.source).toBe("ebay");
    expect(result.normalizedUrl).toBe("https://www.ebay.com/itm/800867457219");
    expect(result.listingId).toBe("800867457219");
  });

  test("matches multi-label country TLDs like ebay.co.uk and ebay.com.au", () => {
    expect(parseUrl("https://www.ebay.co.uk/itm/123456789").normalizedUrl).toBe(
      "https://www.ebay.co.uk/itm/123456789",
    );
    expect(parseUrl("https://ebay.com.au/itm/123456789").normalizedUrl).toBe(
      "https://www.ebay.com.au/itm/123456789",
    );
  });

  test("does not classify an eBay search or shop page as a listing", () => {
    expect(parseUrl("https://www.ebay.com/sch/i.html?_nkw=vinyl").source).toBe("unknown");
    expect(parseUrl("https://www.ebay.com/str/recordshop").source).toBe("unknown");
  });

  test("carries no slug evidence — a numeric id names nothing", () => {
    const result = parseUrl("https://www.ebay.es/itm/800867457219");
    expect(result.slugText).toBeUndefined();
    expect(result.potentialTitle).toBeUndefined();
  });
});

describe("parseUrl - wallapop", () => {
  test("identifies a listing, its id and the slug's words", () => {
    const result = parseUrl(
      "https://es.wallapop.com/item/vinilo-camaron-la-leyenda-del-tiempo-1979-1320305358",
    );

    expect(result.source).toBe("wallapop");
    expect(result.listingId).toBe("1320305358");
    expect(result.slugText).toBe("vinilo camaron la leyenda del tiempo 1979");
    expect(result.normalizedUrl).toBe(
      "https://es.wallapop.com/item/vinilo-camaron-la-leyenda-del-tiempo-1979-1320305358",
    );
  });

  test("matches the bare wallapop.com host", () => {
    const result = parseUrl("https://wallapop.com/item/some-record-42");

    expect(result.source).toBe("wallapop");
    expect(result.listingId).toBe("42");
    expect(result.slugText).toBe("some record");
  });

  test("a slug with no trailing digits yields no listing id", () => {
    const result = parseUrl("https://es.wallapop.com/item/vinilo-camaron");

    expect(result.source).toBe("wallapop");
    expect(result.listingId).toBeUndefined();
    expect(result.slugText).toBe("vinilo camaron");
  });

  test("a digits-only slug carries no words", () => {
    const result = parseUrl("https://es.wallapop.com/item/1320305358");

    expect(result.source).toBe("wallapop");
    expect(result.listingId).toBe("1320305358");
    expect(result.slugText).toBeUndefined();
  });
});

describe("marketplace capability and listing keys", () => {
  test("sourceIsMarketplace names the marketplaces only", () => {
    expect(sourceIsMarketplace("ebay")).toBe(true);
    expect(sourceIsMarketplace("wallapop")).toBe(true);
    expect(sourceIsMarketplace("discogs")).toBe(false);
    expect(sourceIsMarketplace("bandcamp")).toBe(false);
    expect(sourceIsMarketplace("unknown")).toBe(false);
  });

  test("the same listing on two country sites shares one key", () => {
    expect(marketplaceListingKey("https://www.ebay.es/itm/800867457219?itmprp=x")).toBe(
      "ebay:800867457219",
    );
    expect(marketplaceListingKey("https://www.ebay.com/itm/800867457219")).toBe(
      "ebay:800867457219",
    );
    expect(
      marketplaceListingKey(
        "https://es.wallapop.com/item/vinilo-camaron-la-leyenda-del-tiempo-1979-1320305358",
      ),
    ).toBe("wallapop:1320305358");
  });

  test("no key without a listing id — those links dedupe on the exact URL", () => {
    expect(marketplaceListingKey("https://es.wallapop.com/item/vinilo-camaron")).toBeNull();
  });

  test("no key for non-marketplace sources", () => {
    expect(marketplaceListingKey("https://www.discogs.com/sell/item/4334240712")).toBeNull();
    expect(marketplaceListingKey("https://bandcamp.com/album/x")).toBeNull();
    expect(marketplaceListingKey("https://example.com/page")).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import {
  composeEnrichedNotes,
  defaultRankForHost,
  formatLinkSourceNote,
  isAtLeastASentence,
  isKnownLinkSource,
  linkSourceForUrl,
} from "../../domain/link-sources";

describe("linkSourceForUrl", () => {
  test("known hosts map to their curated source", () => {
    expect(linkSourceForUrl("https://pitchfork.com/reviews/albums/10785-in-rainbows/")).toEqual({
      host: "pitchfork.com",
      displayName: "Pitchfork",
    });
    expect(linkSourceForUrl("https://www.allmusic.com/album/in-rainbows-mw0000496930")).toEqual({
      host: "allmusic.com",
      displayName: "AllMusic",
    });
    expect(linkSourceForUrl("https://en.wikipedia.org/wiki/In_Rainbows")).toEqual({
      host: "wikipedia.org",
      displayName: "Wikipedia",
    });
  });

  test("subdomains fold into the known parent host", () => {
    expect(linkSourceForUrl("https://en.m.wikipedia.org/wiki/In_Rainbows")?.host).toBe(
      "wikipedia.org",
    );
    expect(linkSourceForUrl("https://www.pitchfork.com/reviews/albums/x/")?.host).toBe(
      "pitchfork.com",
    );
  });

  test("an unknown host is keyed by its own hostname, www stripped", () => {
    expect(linkSourceForUrl("https://www.theguardian.com/music/2007/oct/10/radiohead")).toEqual({
      host: "theguardian.com",
      displayName: "theguardian.com",
    });
    expect(linkSourceForUrl("https://bandcamp.com/album/x")?.host).toBe("bandcamp.com");
  });

  test("a lookalike host is not the known source", () => {
    expect(linkSourceForUrl("https://notpitchfork.com/reviews/x")?.host).toBe("notpitchfork.com");
    expect(linkSourceForUrl("https://wikipedia.org.evil.example/wiki/x")?.host).toBe(
      "wikipedia.org.evil.example",
    );
  });

  test("unusable URLs return null", () => {
    expect(linkSourceForUrl("not a url")).toBeNull();
    expect(linkSourceForUrl("ftp://wikipedia.org/wiki/x")).toBeNull();
    expect(linkSourceForUrl("")).toBeNull();
  });

  // MusicBrainz url-rels are editable by anyone: a relation must never aim
  // the server-side page fetch at this machine or its private network.
  test("loopback names and addresses are never a source", () => {
    expect(linkSourceForUrl("http://localhost:3000/api/music-items")).toBeNull();
    expect(linkSourceForUrl("http://localhost.:3000/")).toBeNull();
    expect(linkSourceForUrl("http://www.localhost/")).toBeNull();
    expect(linkSourceForUrl("http://sub.localhost/")).toBeNull();
    expect(linkSourceForUrl("http://127.0.0.1:3000/")).toBeNull();
    expect(linkSourceForUrl("http://127.1/")).toBeNull();
  });

  test("IP literals in every form the URL parser accepts are refused", () => {
    // Decimal, hex and octal forms normalise to dotted quads before the gate.
    expect(linkSourceForUrl("http://2130706433/")).toBeNull();
    expect(linkSourceForUrl("http://0x7f000001/")).toBeNull();
    expect(linkSourceForUrl("http://0177.0.0.1/")).toBeNull();
    // Private, link-local (cloud metadata) and public literals alike: a
    // review source is always a named site.
    expect(linkSourceForUrl("http://10.0.0.5/")).toBeNull();
    expect(linkSourceForUrl("http://192.168.1.1/")).toBeNull();
    expect(linkSourceForUrl("http://169.254.169.254/latest/meta-data/")).toBeNull();
    expect(linkSourceForUrl("http://93.184.216.34/")).toBeNull();
    expect(linkSourceForUrl("http://[::1]:3000/")).toBeNull();
    expect(linkSourceForUrl("http://[fe80::1]/")).toBeNull();
    expect(linkSourceForUrl("http://[::ffff:127.0.0.1]/")).toBeNull();
  });

  test("single-label and local-network names are never a source", () => {
    expect(linkSourceForUrl("http://intranet/")).toBeNull();
    expect(linkSourceForUrl("http://printer.local/")).toBeNull();
    expect(linkSourceForUrl("http://server.internal/")).toBeNull();
    expect(linkSourceForUrl("http://nas.lan/")).toBeNull();
    expect(linkSourceForUrl("http://box.home/")).toBeNull();
    // localhost.localdomain is a loopback alias in many hosts files.
    expect(linkSourceForUrl("http://localhost.localdomain:3000/api/music-items")).toBeNull();
    expect(linkSourceForUrl("http://foo.localdomain/")).toBeNull();
    expect(linkSourceForUrl("http://home.arpa/")).toBeNull();
    expect(linkSourceForUrl("http://printer.home.arpa/")).toBeNull();
  });

  test("a trailing dot does not smuggle a host past the gate or the known table", () => {
    expect(linkSourceForUrl("http://localhost./")).toBeNull();
    expect(linkSourceForUrl("https://en.wikipedia.org./wiki/In_Rainbows")?.host).toBe(
      "wikipedia.org",
    );
  });
});

describe("defaultRankForHost", () => {
  test("the curated defaults: Wikipedia 11, Pitchfork 10, AllMusic 9", () => {
    expect(defaultRankForHost("wikipedia.org")).toBe(11);
    expect(defaultRankForHost("pitchfork.com")).toBe(10);
    expect(defaultRankForHost("allmusic.com")).toBe(9);
  });

  test("everything else starts at 0", () => {
    expect(defaultRankForHost("theguardian.com")).toBe(0);
    expect(defaultRankForHost("bandcamp.com")).toBe(0);
  });
});

describe("isKnownLinkSource", () => {
  test("the curated three are known; every other host is not", () => {
    expect(isKnownLinkSource("wikipedia.org")).toBe(true);
    expect(isKnownLinkSource("pitchfork.com")).toBe(true);
    expect(isKnownLinkSource("allmusic.com")).toBe(true);
    expect(isKnownLinkSource("theguardian.com")).toBe(false);
    expect(isKnownLinkSource("spotify.com")).toBe(false);
  });
});

describe("isAtLeastASentence", () => {
  test("empty and whitespace-only notes are not a sentence", () => {
    expect(isAtLeastASentence("")).toBe(false);
    expect(isAtLeastASentence("   \n ")).toBe(false);
  });

  test("a fragment without a terminator is less than a sentence", () => {
    expect(isAtLeastASentence("love this one")).toBe(false);
    expect(isAtLeastASentence("birthday present from Sam")).toBe(false);
  });

  test("a terminated clause reads as a sentence", () => {
    expect(isAtLeastASentence("Bought at Rough Trade.")).toBe(true);
    expect(isAtLeastASentence("Wait, really?")).toBe(true);
    expect(isAtLeastASentence("Never again!")).toBe(true);
    expect(isAtLeastASentence("And so it goes…")).toBe(true);
    expect(isAtLeastASentence("First sentence. Second follows")).toBe(true);
  });

  test("a terminator behind a closing quote or bracket still counts", () => {
    expect(isAtLeastASentence('He said "go."')).toBe(true);
    expect(isAtLeastASentence("The best one (ever.)")).toBe(true);
  });

  test("dots inside a URL do not make a provenance line a sentence", () => {
    expect(
      isAtLeastASentence(
        "From Pitchfork (https://pitchfork.com/reviews/albums/10785-in-rainbows/)",
      ),
    ).toBe(false);
    expect(isAtLeastASentence("From https://en.wikipedia.org/wiki/In_Rainbows")).toBe(false);
    expect(isAtLeastASentence("www.allmusic.com")).toBe(false);
  });
});

describe("composeEnrichedNotes", () => {
  const paragraph = "In Rainbows is the seventh studio album by Radiohead.";
  const url = "https://en.wikipedia.org/wiki/In_Rainbows";

  test("empty notes take the paragraph and its source line whole", () => {
    expect(composeEnrichedNotes(null, paragraph, "Wikipedia", url)).toBe(
      `${paragraph} — From Wikipedia (${url})`,
    );
    expect(composeEnrichedNotes("   ", paragraph, "Wikipedia", url)).toBe(
      `${paragraph} — From Wikipedia (${url})`,
    );
  });

  test("a short note keeps its place, the paragraph lands beneath it", () => {
    expect(composeEnrichedNotes("love this one", paragraph, "Wikipedia", url)).toBe(
      `love this one\n\n${paragraph} — From Wikipedia (${url})`,
    );
  });

  test("the source line matches the repo's provenance shape", () => {
    expect(formatLinkSourceNote("Pitchfork", url)).toBe(`From Pitchfork (${url})`);
  });
});

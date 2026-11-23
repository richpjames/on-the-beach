import { describe, expect, test } from "bun:test";
import {
  composeEnrichedNotes,
  defaultRankForHost,
  formatLinkSourceNote,
  isAtLeastASentence,
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

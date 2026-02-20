import { describe, it, expect } from "vitest";
import { extractMusicUrls } from "../../server/email-parser";

describe("extractMusicUrls", () => {
  it("extracts bandcamp URLs from HTML anchor tags", () => {
    const html = `<a href="https://artist.bandcamp.com/album/cool-album">Listen now</a>`;
    expect(extractMusicUrls({ html })).toEqual(["https://artist.bandcamp.com/album/cool-album"]);
  });

  it("extracts multiple bandcamp URLs from a real-ish notification email", () => {
    const html = `
      <html>
      <body>
        <p>New release from Seekers International!</p>
        <a href="https://seekersinternational.bandcamp.com/album/new-album">Listen</a>
        <a href="https://seekersinternational.bandcamp.com/track/single-track">Single</a>
        <a href="https://bandcamp.com/about">About Bandcamp</a>
      </body>
      </html>
    `;
    expect(extractMusicUrls({ html })).toEqual([
      "https://seekersinternational.bandcamp.com/album/new-album",
      "https://seekersinternational.bandcamp.com/track/single-track",
    ]);
  });

  it("extracts spotify URLs from HTML", () => {
    const html = `<a href="https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy">Album</a>`;
    expect(extractMusicUrls({ html })).toEqual([
      "https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy",
    ]);
  });

  it("extracts URLs from plain text when no HTML is provided", () => {
    const text = "Check out https://open.spotify.com/album/abc123 it's great";
    expect(extractMusicUrls({ text })).toEqual(["https://open.spotify.com/album/abc123"]);
  });

  it("falls back to text extraction when HTML has no hrefs", () => {
    const html = "<p>No links here, just text</p>";
    const text = "But here: https://artist.bandcamp.com/album/fallback";
    expect(extractMusicUrls({ html, text })).toEqual([
      "https://artist.bandcamp.com/album/fallback",
    ]);
  });

  it("ignores non-music URLs", () => {
    const html = `
      <a href="https://www.google.com">Google</a>
      <a href="https://artist.bandcamp.com/album/yes">Music</a>
      <a href="https://unsubscribe.example.com/click?id=123">Unsubscribe</a>
    `;
    expect(extractMusicUrls({ html })).toEqual(["https://artist.bandcamp.com/album/yes"]);
  });

  it("deduplicates URLs", () => {
    const html = `
      <a href="https://artist.bandcamp.com/album/dupe">Link 1</a>
      <a href="https://artist.bandcamp.com/album/dupe">Link 2</a>
    `;
    expect(extractMusicUrls({ html })).toEqual(["https://artist.bandcamp.com/album/dupe"]);
  });

  it("strips query parameters from extracted URLs", () => {
    const html = `<a href="https://artist.bandcamp.com/album/test?utm_source=email&utm_medium=notification">Link</a>`;
    expect(extractMusicUrls({ html })).toEqual(["https://artist.bandcamp.com/album/test"]);
  });

  it("returns empty array when no music URLs found", () => {
    expect(extractMusicUrls({ text: "Hello, no links here" })).toEqual([]);
  });

  it("returns empty array when given empty input", () => {
    expect(extractMusicUrls({})).toEqual([]);
  });

  it("handles soundcloud URLs", () => {
    const html = `<a href="https://soundcloud.com/artist/track-name">Listen</a>`;
    expect(extractMusicUrls({ html })).toEqual(["https://soundcloud.com/artist/track-name"]);
  });

  it("handles mixed platform URLs in one email", () => {
    const html = `
      <a href="https://artist.bandcamp.com/album/one">BC</a>
      <a href="https://open.spotify.com/album/abc123">Spotify</a>
      <a href="https://www.example.com/nothing">Nothing</a>
    `;
    const result = extractMusicUrls({ html });
    expect(result).toHaveLength(2);
    expect(result).toContain("https://artist.bandcamp.com/album/one");
    expect(result).toContain("https://open.spotify.com/album/abc123");
  });
});

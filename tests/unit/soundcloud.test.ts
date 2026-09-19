import { describe, expect, it } from "bun:test";
import { extractSoundcloudUrn, soundcloudWidgetSrc } from "../../adapters/soundcloud/index";

// Hydra-state fragments as SoundCloud actually serves them: the page's own
// resource first, then whatever else the page names.
const TRACK_PAGE_HTML = `
  <script>{"hydratable":"user","data":{"id":475471,"kind":"user"}}</script>
  <script>{"hydratable":"sound","data":{"artwork_url":"https://i1.sndcdn.com/x-0-t500x500.png",
    "genre":"Electronic","id":1441376377,"kind":"track","title":"Roygbiv",
    "uri":"https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A1441376377",
    "urn":"soundcloud:tracks:1441376377","user_id":475471}}</script>
`;

const SET_PAGE_HTML = `
  <script>{"hydratable":"playlist","data":{"genre":"Electronic","id":1566800707,"kind":"playlist","title":"Music Has The Right To Children"}}</script>
  <script>{"hydratable":"sound","data":{"genre":"Electronic","id":1441390735,"kind":"track"}}</script>
`;

describe("extractSoundcloudUrn", () => {
  it("reads the track off a track page", () => {
    expect(extractSoundcloudUrn(TRACK_PAGE_HTML)).toBe("soundcloud:tracks:1441376377");
  });

  it("prefers the playlist over the tracks inside a set page", () => {
    expect(extractSoundcloudUrn(SET_PAGE_HTML)).toBe("soundcloud:playlists:1566800707");
  });

  it("returns null when the page names no playable resource", () => {
    expect(extractSoundcloudUrn('{"hydratable":"user","data":{"id":1,"kind":"user"}}')).toBeNull();
    expect(extractSoundcloudUrn("")).toBeNull();
  });
});

describe("soundcloudWidgetSrc", () => {
  it("builds the widget url for a track urn", () => {
    expect(soundcloudWidgetSrc("soundcloud:tracks:1441376377")).toBe(
      "https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/1441376377&visual=false&show_artwork=false&hide_related=true&show_comments=false",
    );
  });

  it("builds the widget url for a playlist urn", () => {
    expect(soundcloudWidgetSrc("soundcloud:playlists:1566800707")).toBe(
      "https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/playlists/1566800707&visual=false&show_artwork=false&hide_related=true&show_comments=false",
    );
  });

  it("returns null for anything that isn't a track or playlist urn", () => {
    expect(soundcloudWidgetSrc("soundcloud:users:475471")).toBeNull();
    expect(soundcloudWidgetSrc("https://soundcloud.com/nozwon/a-mix")).toBeNull();
    expect(soundcloudWidgetSrc(null)).toBeNull();
    expect(soundcloudWidgetSrc(undefined)).toBeNull();
    expect(soundcloudWidgetSrc("")).toBeNull();
  });
});

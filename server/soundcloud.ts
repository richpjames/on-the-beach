/**
 * Everything the app knows about SoundCloud playback.
 *
 * SoundCloud pages are an SPA shell: the head carries the OG tags the scraper
 * parses for title/artist (parseSoundcloudOg, in scraper.ts), but the track id
 * the player needs only appears in the hydra-state JSON in the page body. So a
 * SoundCloud link is scraped for its resource urn — SoundCloud's own id form
 * (`soundcloud:tracks:123`) — the same arrangement Bandcamp's `album_id` uses.
 *
 * The widget itself refuses permalinks: its `url` param wants an
 * api.soundcloud.com resource URL, encoded the way SoundCloud's own embeds do
 * (the colon escaped, the slashes left alone).
 */

const TRACK_ID = /"id":(\d+),"kind":"track"/;
const PLAYLIST_ID = /"id":(\d+),"kind":"playlist"/;

/**
 * The page's own resource urn, or null when the HTML names none.
 *
 * A set page also embeds the urns of the tracks inside the set, so the
 * playlist match has to win when there is one; on a track page the only
 * `"kind":"track"` object is the page's own.
 */
export function extractSoundcloudUrn(html: string): string | null {
  const playlist = PLAYLIST_ID.exec(html);
  if (playlist) return `soundcloud:playlists:${playlist[1]}`;

  const track = TRACK_ID.exec(html);
  if (track) return `soundcloud:tracks:${track[1]}`;

  return null;
}

/**
 * The player for a SoundCloud track or set, as the release page embeds it.
 *
 * The classic compact player (`visual=false`) matches the Bandcamp embed's
 * proportions; `show_artwork=false` mirrors Bandcamp's `artwork=none` — the
 * page is already showing the artwork above the listen row. Returns null for
 * anything that isn't a track or playlist urn.
 */
export function soundcloudWidgetSrc(urn: string | null | undefined): string | null {
  const match = /^soundcloud:(tracks|playlists):(\d+)$/.exec(urn ?? "");
  if (!match) return null;

  return `https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/${match[1]}/${match[2]}&visual=false&show_artwork=false&hide_related=true&show_comments=false`;
}

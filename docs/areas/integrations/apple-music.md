# Apple Music (MusicKit) integration

On The Beach integrates Apple Music in two layers:

1. **Catalogue lookup (server)** — resolving a release to its Apple Music page,
   stored as a secondary listen link.
2. **Full-track playback (browser)** — streaming the whole track in the app's
   player via Apple's MusicKit JS, rather than the 30-second preview the public
   `embed.music.apple.com` iframe offers.

Both layers are enabled by the same MusicKit credentials. When they are absent,
the app degrades gracefully: catalogue lookup falls back to the open iTunes
Search API, and playback falls back to the preview iframe.

## Configuration

Create a **MusicKit key** in the Apple Developer portal (Certificates,
Identifiers & Profiles → Keys → enable _MusicKit_) and download the
`AuthKey_XXXXXXXXXX.p8`. Then set:

| Variable                  | What it is                                       |
| ------------------------- | ------------------------------------------------ |
| `APPLE_MUSIC_TEAM_ID`     | Your 10-char Apple Developer Team ID (JWT `iss`) |
| `APPLE_MUSIC_KEY_ID`      | The MusicKit key's Key ID (JWT header `kid`)     |
| `APPLE_MUSIC_PRIVATE_KEY` | The `.p8` file contents (PKCS#8 PEM)             |
| `APPLE_MUSIC_STOREFRONT`  | Optional storefront code, default `gb`           |

`APPLE_MUSIC_PRIVATE_KEY` accepts the PEM with real newlines or with `\n`
escapes (for hosting UIs that can't hold multi-line values), and tolerates the
PEM armour being stripped.

## Developer token

`server/apple-music-token.ts` mints an ES256-signed JWT (the _developer token_)
from the credentials, caches it in memory, and refreshes it a day before
expiry. The token is deliberately safe to hand to the browser — it grants only
team-scoped catalogue access and expires. It is served from:

- `GET /api/apple-music/config` → `{ configured, storefront }`
- `GET /api/apple-music/token` → `{ token, storefront }` (503 when unconfigured)

## Catalogue lookup

`searchAppleMusic` (in `server/scraper.ts`) first tries the Apple Music Catalog
API (`server/apple-music-catalog.ts`) using the developer token, then falls back
to the iTunes Search API. Both return a `music.apple.com` URL; the catalogue API
path yields URLs that carry the catalogue ids MusicKit needs for playback.

The lookup is wired into the shared secondary-link enrichment
(`server/secondary-link-enrichment.ts`), so nothing else changes about when or
how Apple Music links are attached to items.

## Browser playback

- `src/lib/musickit.svelte.ts` loads MusicKit JS v3 on demand, configures it
  with the developer token, and exposes a small reactive facade (availability,
  authorised, playing, position/duration, now-playing metadata) plus
  `authorize`, `playResource`, `togglePlay`, `seek`, and `stop`.
- `shared/apple-music.ts` parses a stored `music.apple.com` URL into the
  `{ kind, id }` MusicKit's `setQueue` needs (`album` / `song` / `playlist` /
  `musicVideo`), including `?i=` track deep-links.
- `src/lib/player.svelte.ts` gains an `apple_music` mode alongside the existing
  iframe mode; `PlayerWindow.svelte` renders native transport controls (artwork,
  play/pause, seek bar, and a "Sign in to Apple Music" prompt) for that mode.
- The release page's "Listen on Apple Music" button starts MusicKit playback on
  desktop; on touch devices it hands off to the native Apple Music app/site, as
  the other listen buttons do.

Playing a full track requires the listener to authorise their own Apple Music
subscription once (from the player or the Settings page). Without a
subscription, MusicKit still plays previews.

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

`adapters/apple-music-token.ts` mints an ES256-signed JWT (the _developer token_)
from the credentials, caches it in memory, and refreshes it a day before
expiry. The token is deliberately safe to hand to the browser — it grants only
team-scoped catalogue access and expires. It is served from:

- `GET /api/apple-music/config` → `{ configured, storefront }`
- `GET /api/apple-music/token` → `{ token, storefront }` (503 when unconfigured)

## Catalogue lookup

`searchAppleMusic` (in `adapters/apple-music/scrape.ts`) first tries the Apple Music Catalog
API (`adapters/apple-music/catalog.ts`) using the developer token, then falls back
to the iTunes Search API. Both return a `ServiceSearchResult` — the
`music.apple.com` URL plus the release's cover `artworkUrl` when the service
exposes one. The catalogue API path yields URLs that carry the catalogue ids
MusicKit needs for playback; its artwork template is resolved to a concrete
1200×1200 image (the iTunes path upscales `artworkUrl100` the same way).

The lookup is wired into the shared secondary-link enrichment
(`app/secondary-link-enrichment.ts`), so nothing else changes about when or
how Apple Music links are attached to items. When the resolved release carries
artwork and the item has none of its own, that cover is saved to the item's
`artworkUrl` (never overwriting existing art) — so pulling a release from Apple
Music now brings its artwork along too.

Before either search runs, the item's MusicBrainz url relations are consulted
(`findAppleMusicUrlViaMusicBrainz`): editors attach the record's own Apple Music
page to the release, so that link needs no fuzzy matching — and no dependence
on the item's artist credit being the one Apple carries the record under. The
release's own relations are asked first, then its release group's. The attached
page is scraped for cover art and label on the same gap-only terms as a search
hit.

A release maps to a record, not one track: when a song is the best search
match, its catalogue URL — a `?i=` deep-link into the album — is reduced to the
album URL (`appleMusicAlbumUrl` in `domain/apple-music.ts`), so the player
queues the whole record. The iTunes path has always answered this way, stripping
the query off a track's collection URL. A `?i=` link the user pastes themselves
still plays as the single track it names.

When Apple Music has no match at all, the enrichment falls back to a Bandcamp
page named in the same MusicBrainz url relations, and failing that a YouTube
search that saves a link only when the match is unambiguous — see the fallback
sections of `docs/areas/integrations/scanning-and-enrichment.md`.

Links attached before these rules existed — the old artist-only search pass
could link the artist's *other* release, and song matches stored track
deep-links — are repaired by `scripts/repair-apple-music-links.ts`: the
MusicBrainz-attached page replaces a wrong link, and a deep-link with no
MusicBrainz page is reduced to its album. Secondary links only; `--dry-run`
lists the planned repairs. Backfilling cannot do this — it skips items that
already have a link.

A lookup stamps `music_items.apple_music_lookup_at` on both a hit and a miss, so
a release the catalogue doesn't carry isn't re-queried on every page view. Since
the search keys off nothing but the item's title and artist, editing either one
(`PATCH /api/music-items/:id`) clears that marker, and the next release-page view
searches again under the corrected name — the usual reason an item ends up with
no listen link is a title that was wrong when it was first looked up. Re-saving
the edit form without actually changing those fields leaves the marker alone.

## Browser playback

- `src/lib/musickit.svelte.ts` loads MusicKit JS v3 on demand, configures it
  with the developer token, and exposes a small reactive facade (availability,
  authorised, playing, position/duration, now-playing metadata) plus
  `authorize`, `playResource`, `togglePlay`, `seek`, and `stop`.
- `domain/apple-music.ts` parses a stored `music.apple.com` URL into the
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

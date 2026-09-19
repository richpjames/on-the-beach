/**
 * The sources we model, and what each one lets you do with a record.
 *
 * `canPlay` / `canBuy` / `isEditorial` are independent flags rather than a
 * single role, because the cases overlap: Bandcamp plays *and* sells, Discogs
 * sells without playing, and Pitchfork does neither — it writes about the
 * record. All three false is a meaningful answer, not a gap: a physical copy is
 * off the web entirely.
 *
 * This list is the *initial* data only. Both seeding paths insert with
 * `onConflictDoNothing`, so neither ever rewrites a row that already exists —
 * changing a classification on installs that are already migrated takes a
 * migration (see `drizzle/0016_great_sandman.sql`).
 *
 * Lives in its own module because it is read from two places that must not
 * drift: `./index.ts` seeds on first open (every dev, test and production
 * database goes through it) and `./seed.ts` is the explicit `bun run db:seed`
 * entrypoint. It was previously copy-pasted into both.
 */
export const SEED_SOURCES = [
  {
    name: "bandcamp",
    displayName: "Bandcamp",
    urlPattern: "bandcamp.com",
    canPlay: true,
    canBuy: true,
    isEditorial: false,
  },
  {
    name: "spotify",
    displayName: "Spotify",
    urlPattern: "open.spotify.com",
    canPlay: true,
    canBuy: false,
    isEditorial: false,
  },
  {
    name: "soundcloud",
    displayName: "SoundCloud",
    urlPattern: "soundcloud.com",
    canPlay: true,
    canBuy: false,
    isEditorial: false,
  },
  {
    name: "youtube",
    displayName: "YouTube",
    urlPattern: "youtube.com",
    canPlay: true,
    canBuy: false,
    isEditorial: false,
  },
  {
    // music.apple.com is the streaming product, which is what the URL patterns
    // and the catalogue search target. itunes.apple.com purchase links parse as
    // `apple_music` too, so `canBuy` is arguably true here — it is left false
    // deliberately, because the source's primary function is playback and
    // nothing reads `canBuy` yet. Flip it when a purchase path appears.
    name: "apple_music",
    displayName: "Apple Music",
    urlPattern: "music.apple.com",
    canPlay: true,
    canBuy: false,
    isEditorial: false,
  },
  {
    name: "discogs",
    displayName: "Discogs",
    urlPattern: "discogs.com",
    canPlay: false,
    canBuy: true,
    isEditorial: false,
  },
  {
    name: "tidal",
    displayName: "Tidal",
    urlPattern: "tidal.com",
    canPlay: true,
    canBuy: false,
    isEditorial: false,
  },
  {
    name: "deezer",
    displayName: "Deezer",
    urlPattern: "deezer.com",
    canPlay: true,
    canBuy: false,
    isEditorial: false,
  },
  {
    name: "mixcloud",
    displayName: "Mixcloud",
    urlPattern: "mixcloud.com",
    canPlay: true,
    canBuy: false,
    isEditorial: false,
  },
  {
    name: "nts",
    displayName: "NTS Radio",
    urlPattern: "nts.live",
    canPlay: true,
    canBuy: false,
    isEditorial: false,
  },
  {
    name: "pitchfork",
    displayName: "Pitchfork",
    urlPattern: "pitchfork.com",
    canPlay: false,
    canBuy: false,
    isEditorial: true,
  },
  {
    // A record on the shelf: nothing on the web to play, buy or read.
    name: "physical",
    displayName: "Physical Media",
    urlPattern: null,
    canPlay: false,
    canBuy: false,
    isEditorial: false,
  },
] as const;

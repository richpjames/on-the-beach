import { db } from './index'
import { sources } from './schema'

const SEED_SOURCES = [
  { name: 'bandcamp', displayName: 'Bandcamp', urlPattern: 'bandcamp.com' },
  { name: 'spotify', displayName: 'Spotify', urlPattern: 'open.spotify.com' },
  { name: 'soundcloud', displayName: 'SoundCloud', urlPattern: 'soundcloud.com' },
  { name: 'youtube', displayName: 'YouTube', urlPattern: 'youtube.com' },
  { name: 'apple_music', displayName: 'Apple Music', urlPattern: 'music.apple.com' },
  { name: 'discogs', displayName: 'Discogs', urlPattern: 'discogs.com' },
  { name: 'tidal', displayName: 'Tidal', urlPattern: 'tidal.com' },
  { name: 'deezer', displayName: 'Deezer', urlPattern: 'deezer.com' },
  { name: 'mixcloud', displayName: 'Mixcloud', urlPattern: 'mixcloud.com' },
  { name: 'physical', displayName: 'Physical Media', urlPattern: null },
] as const

async function seed() {
  console.log('Seeding sources...')
  for (const source of SEED_SOURCES) {
    await db
      .insert(sources)
      .values(source)
      .onConflictDoNothing({ target: sources.name })
  }
  console.log('Seeding complete.')
  process.exit(0)
}

seed().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})

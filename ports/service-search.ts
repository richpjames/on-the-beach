/**
 * Finding a release on a streaming service.
 *
 * This is a port, not a source: Apple Music, Spotify and YouTube each satisfy
 * it, and the use cases that consume it — `secondary-link-enrichment`,
 * `release-link-check`, `apple-music-backfill` — care only about the shape.
 * It lived in `apple-music-catalog.ts` and was re-exported through
 * `scraper.ts`, which made every consumer name an adapter to describe a
 * contract none of them wanted an adapter for.
 */

/**
 * The result of resolving a release on a streaming service: its catalogue URL
 * plus, when the service exposes one, a ready-to-use cover artwork URL.
 */
export interface ServiceSearchResult {
  url: string;
  artworkUrl: string | null;
}

/**
 * Search a service for a release by title and artist, returning the best match
 * or null when there isn't one. Implemented by `searchAppleMusic`,
 * `searchAppleMusicCatalog`, `searchSpotify` and `searchYouTube`.
 */
export type ServiceSearch = (
  title: string,
  artist: string | null,
  timeoutMs?: number,
) => Promise<ServiceSearchResult | null>;

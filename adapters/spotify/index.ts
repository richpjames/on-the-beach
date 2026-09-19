/**
 * The Spotify adapter.
 *
 * STUB: Spotify's Web API (unlike the open iTunes Search API) requires OAuth app
 * credentials via the Client Credentials flow. This is intentionally left as a
 * no-op until SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are configured and the
 * token + /v1/search implementation lands. Returning null means the active
 * service can be switched to Spotify in the UI without breaking lookups — they
 * simply find nothing for now.
 */
import type { ServiceSearchResult } from "../../ports/service-search";

/**
 * Search Spotify for a release by title and artist, returning the best-matching
 * Spotify URL, or null if not found.
 */
export async function searchSpotify(
  _title: string,
  _artist: string | null,
  _timeoutMs = 8000,
): Promise<ServiceSearchResult | null> {
  if (process.env.OTB_DISABLE_EXTERNAL_LOOKUPS) return null;

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    // Not configured — Spotify lookups cleanly no-op until credentials exist.
    return null;
  }

  // TODO: obtain a Client Credentials token from accounts.spotify.com and query
  // https://api.spotify.com/v1/search?type=album,track — then match like
  // searchAppleMusic above and return the result's external Spotify URL.
  return null;
}

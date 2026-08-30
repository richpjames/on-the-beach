/**
 * The Apple Music adapter's public face.
 *
 * Callers outside this folder import from here, not from the files inside it,
 * so the split between `scrape`, `catalog`, `token` and `match` stays an
 * internal detail. `domain/apple-music.ts` is deliberately not re-exported:
 * parsing a catalogue URL is pure and the browser needs it too, so it belongs
 * in the core rather than behind an adapter.
 */
export {
  fetchAppleMusicApiMetadata,
  isCompleteAppleMusicMetadata,
  mergeAppleMusicPageMetadata,
  NO_APPLE_MUSIC_API_METADATA,
  parseAppleMusicOg,
  searchAppleMusic,
  searchAppleMusicViaItunes,
  type AppleMusicApiMetadata,
} from "./scrape";
export { searchAppleMusicCatalog } from "./catalog";
export {
  getDeveloperToken,
  getStorefront,
  isAppleMusicConfigured,
  mintDeveloperToken,
  readAppleMusicCredentials,
  resetDeveloperTokenCache,
  type AppleMusicCredentials,
} from "./token";

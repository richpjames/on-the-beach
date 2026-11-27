/**
 * The Qobuz adapter's public face.
 *
 * Callers outside this folder import from here, not from the files inside it,
 * so the split between `api`, `scrape` and `search` stays an internal detail.
 */
export { scrapeQobuz } from "./scrape";
export { searchQobuz } from "./search";
export { isQobuzConfigured, resetQobuzAuthCache } from "./api";

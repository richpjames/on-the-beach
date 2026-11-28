/**
 * The Qobuz API client: configuration, optional authentication, and the
 * request helper the scrape and search share.
 *
 * Qobuz publishes no documented public API — the JSON API at
 * `www.qobuz.com/api.json/0.2` is the one their own players use, and every
 * request carries an `app_id`. The id defaulted here is one Qobuz ship in
 * their public web bundle; it answers catalogue reads anonymously. Set
 * `QOBUZ_APP_ID` to use another.
 *
 * An account is optional. With `QOBUZ_EMAIL` + `QOBUZ_PASSWORD` the client
 * logs in via `user/login` and caches the returned token; a
 * `QOBUZ_USER_AUTH_TOKEN` supplies one directly (e.g. lifted from a
 * signed-in browser session). Neither is needed while anonymous reads work
 * — they are there for the day Qobuz tighten them, and for installs that
 * would rather ask as a signed-in listener.
 */
import { isRecord } from "../web/html-metadata";

const API_BASE = "https://www.qobuz.com/api.json/0.2";

/** An app id published in Qobuz's own web bundle; catalogue reads answer it anonymously. */
const DEFAULT_APP_ID = "425621600";

export function getAppId(): string {
  return process.env.QOBUZ_APP_ID?.trim() || DEFAULT_APP_ID;
}

/**
 * The storefront locale (`cc-ll`) returned URLs are rewritten to, so a link
 * found through the API opens in the listener's own store rather than the
 * French one the API answers with by default.
 */
export function getStorefront(): string {
  const raw = process.env.QOBUZ_STOREFRONT?.trim().toLowerCase();
  return raw && /^[a-z]{2}-[a-z]{2}$/.test(raw) ? raw : "gb-en";
}

/** Rewrite a qobuz.com URL's locale segment to the configured storefront. */
export function qobuzStorefrontUrl(url: string): string {
  return url.replace(
    /^(https?:\/\/(?:www\.)?qobuz\.com\/)[a-z]{2}-[a-z]{2}(\/)/i,
    `$1${getStorefront()}$2`,
  );
}

export interface QobuzCredentials {
  email: string;
  password: string;
}

/** Read the account credentials, returning null unless both are present. */
export function readQobuzCredentials(): QobuzCredentials | null {
  const email = process.env.QOBUZ_EMAIL?.trim();
  const password = process.env.QOBUZ_PASSWORD;
  if (!email || !password) return null;
  return { email, password };
}

/** Whether an account is configured — anonymous catalogue reads need nothing. */
export function isQobuzConfigured(): boolean {
  return Boolean(process.env.QOBUZ_USER_AUTH_TOKEN?.trim()) || readQobuzCredentials() !== null;
}

let cachedToken: string | null = null;
let loginInFlight: Promise<string | null> | null = null;
let loginBlockedUntil = 0;

/** How long a failed login is remembered before another attempt is made. */
const FAILED_LOGIN_RETRY_MS = 60_000;

/** Clear the cached login state (token, in-flight login, failure memory). Exported for tests. */
export function resetQobuzAuthCache(): void {
  cachedToken = null;
  loginInFlight = null;
  loginBlockedUntil = 0;
}

async function login(credentials: QobuzCredentials, timeoutMs: number): Promise<string | null> {
  const params = new URLSearchParams({
    email: credentials.email,
    password: credentials.password,
    app_id: getAppId(),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API_BASE}/user/login?${params.toString()}`, {
      signal: controller.signal,
      headers: { Accept: "application/json", "X-App-Id": getAppId() },
    });

    if (!response.ok) return null;

    const data = (await response.json()) as unknown;
    if (!isRecord(data)) return null;
    return typeof data.user_auth_token === "string" && data.user_auth_token
      ? data.user_auth_token
      : null;
  } catch (err) {
    // The request URL carries the password, and a fetch error can embed it —
    // log the error's name only, never the object.
    console.error("[qobuz] login failed:", err instanceof Error ? err.name : "unknown error");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function getAuthToken(timeoutMs: number): Promise<string | null> {
  const direct = process.env.QOBUZ_USER_AUTH_TOKEN?.trim();
  if (direct) return direct;
  if (cachedToken) return cachedToken;

  const credentials = readQobuzCredentials();
  if (!credentials) return null;
  // A failed login is remembered briefly: a wrong password must not make
  // every request re-attempt it before falling back to anonymous.
  if (Date.now() < loginBlockedUntil) return null;

  // Share one in-flight login between concurrent callers (a bulk backfill
  // fires many at once) rather than logging in once per request.
  if (!loginInFlight) {
    loginInFlight = login(credentials, timeoutMs).then((token) => {
      loginInFlight = null;
      if (token) cachedToken = token;
      else loginBlockedUntil = Date.now() + FAILED_LOGIN_RETRY_MS;
      return token;
    });
  }
  return loginInFlight;
}

/**
 * GET an API endpoint, returning the parsed JSON object, or null on any
 * failure — a scrape or a search reports "nothing found", never a transport
 * error. A 401 on a cached login token invalidates it and retries once
 * (tokens expire), sharing any re-login already in flight; anonymous reads
 * and env-supplied tokens are not retried. Login, request and retry share
 * one deadline of `timeoutMs` — the call never blocks for more than that.
 */
export async function fetchQobuzApi(
  endpoint: string,
  params: Record<string, string>,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  // One deadline for the whole call — login, request and any 401 retry share
  // the caller's budget rather than each getting a fresh one.
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const token = await getAuthToken(remaining);
    const budget = deadline - Date.now();
    if (budget <= 0) return null;
    const query = new URLSearchParams({ ...params, app_id: getAppId() });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      const response = await fetch(`${API_BASE}/${endpoint}?${query.toString()}`, {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "X-App-Id": getAppId(),
          ...(token ? { "X-User-Auth-Token": token } : {}),
        },
      });

      const tokenIsCachedLogin = token !== null && !process.env.QOBUZ_USER_AUTH_TOKEN?.trim();
      if (response.status === 401 && attempt === 0 && tokenIsCachedLogin) {
        // Invalidate only the token this request used — a concurrent re-login
        // may already have cached a fresh one, and wiping the shared
        // in-flight login would make every parallel 401 issue its own.
        if (cachedToken === token) cachedToken = null;
        continue;
      }

      if (!response.ok) return null;

      const data = (await response.json()) as unknown;
      return isRecord(data) ? data : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

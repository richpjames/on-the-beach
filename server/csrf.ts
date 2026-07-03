/**
 * Cookie-based CSRF protection (double-submit token).
 *
 * The handle hook issues a random token cookie; browser clients echo it in the
 * `x-csrf-token` header. An unsafe-method request is allowed when either:
 *
 * - its `Origin` header matches the site origin (browsers always attach Origin
 *   to cross-origin unsafe requests, so a forged request from another site
 *   fails this check), or
 * - it carries a token header matching the cookie (which a cross-site attacker
 *   cannot read).
 *
 * Non-browser clients without an Origin header (curl, integration scripts)
 * must send the token; the email ingest webhook is exempt because it is
 * authenticated with a bearer token and posts cross-origin multipart bodies.
 */

export const CSRF_COOKIE_NAME = "otb_csrf";
export const CSRF_HEADER_NAME = "x-csrf-token";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const EXEMPT_PATH_PREFIXES = ["/api/ingest"];

export function createCsrfToken(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

export interface CsrfRequestContext {
  method: string;
  pathname: string;
  /** `Origin` request header, if any. */
  requestOrigin: string | null;
  /** Origin of the site as seen by the server (event.url.origin). */
  siteOrigin: string;
  cookieToken: string | null;
  headerToken: string | null;
}

export function isCsrfRequestAllowed(context: CsrfRequestContext): boolean {
  if (!UNSAFE_METHODS.has(context.method.toUpperCase())) {
    return true;
  }

  if (EXEMPT_PATH_PREFIXES.some((prefix) => context.pathname.startsWith(prefix))) {
    return true;
  }

  if (context.requestOrigin !== null && context.requestOrigin === context.siteOrigin) {
    return true;
  }

  return (
    context.cookieToken !== null &&
    context.headerToken !== null &&
    context.headerToken === context.cookieToken
  );
}

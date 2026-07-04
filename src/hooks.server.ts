import { json, type Handle } from "@sveltejs/kit";
import { building } from "$app/environment";
import { processReminders } from "../server/reminders";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  createCsrfToken,
  isCsrfRequestAllowed,
} from "../server/csrf";

// ---------- Reminder cron ----------
// Run reminder processing on startup and then every hour. Guarded so dev-mode
// module reloads don't stack intervals, and skipped entirely while SvelteKit
// builds/analyses the app — the build environment has no database.
const globalState = globalThis as typeof globalThis & { __otbRemindersStarted?: boolean };
if (!building && !globalState.__otbRemindersStarted) {
  globalState.__otbRemindersStarted = true;
  processReminders().catch((err) => console.error("[reminders] startup run failed:", err));
  setInterval(
    () => processReminders().catch((err) => console.error("[reminders] interval run failed:", err)),
    60 * 60 * 1000,
  );
}

// ---------- Preview deployments ----------
// Preview environments start with an empty database; PREVIEW_SEED=1 fills it
// with demo content so the preview is explorable. No-op once data exists.
// Dynamically imported so the build never touches the database.
if (!building && process.env["PREVIEW_SEED"] === "1") {
  import("../server/preview-seed")
    .then(({ seedPreviewData }) => seedPreviewData())
    .catch((err) => console.error("[preview-seed] failed:", err));
}

// Pages that restyle the retro window chrome need their class on <body> at SSR
// time (the stylesheet targets `body.release-page-body` and its direct children).
function bodyClassForRoute(routeId: string | null): string {
  return routeId === "/r/[id]" ? "release-page-body" : "";
}

export const handle: Handle = async ({ event, resolve }) => {
  // ---------- CSRF (double-submit cookie) ----------
  // See server/csrf.ts. Not httpOnly: the client reads the cookie to echo it
  // in the x-csrf-token header — the token carries no authority by itself.
  let csrfToken = event.cookies.get(CSRF_COOKIE_NAME) ?? null;
  if (!csrfToken) {
    csrfToken = createCsrfToken();
    event.cookies.set(CSRF_COOKIE_NAME, csrfToken, {
      path: "/",
      httpOnly: false,
      sameSite: "lax",
      secure: event.url.protocol === "https:",
    });
  }

  const allowed = isCsrfRequestAllowed({
    method: event.request.method,
    pathname: event.url.pathname,
    requestOrigin: event.request.headers.get("origin"),
    siteOrigin: event.url.origin,
    cookieToken: csrfToken,
    headerToken: event.request.headers.get(CSRF_HEADER_NAME),
  });
  if (!allowed) {
    return json({ error: "CSRF token missing or invalid" }, { status: 403 });
  }

  const bodyClass = bodyClassForRoute(event.route.id);
  return resolve(event, {
    transformPageChunk: ({ html }) => html.replaceAll("%otb.body_class%", bodyClass),
  });
};

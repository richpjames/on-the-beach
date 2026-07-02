import type { Handle } from "@sveltejs/kit";
import { processReminders } from "../server/reminders";

// ---------- Reminder cron ----------
// Run reminder processing on startup and then every hour. Guarded so dev-mode
// module reloads don't stack intervals.
const globalState = globalThis as typeof globalThis & { __otbRemindersStarted?: boolean };
if (!globalState.__otbRemindersStarted) {
  globalState.__otbRemindersStarted = true;
  processReminders().catch((err) => console.error("[reminders] startup run failed:", err));
  setInterval(
    () => processReminders().catch((err) => console.error("[reminders] interval run failed:", err)),
    60 * 60 * 1000,
  );
}

// Pages that restyle the retro window chrome need their class on <body> at SSR
// time (the stylesheet targets `body.release-page-body` and its direct children).
function bodyClassForRoute(routeId: string | null): string {
  return routeId === "/r/[id]" ? "release-page-body" : "";
}

export const handle: Handle = async ({ event, resolve }) => {
  const bodyClass = bodyClassForRoute(event.route.id);
  return resolve(event, {
    transformPageChunk: ({ html }) => html.replaceAll("%otb.body_class%", bodyClass),
  });
};

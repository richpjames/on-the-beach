/**
 * An action the app is asked to run as it opens, carried in the URL.
 *
 * The native iOS shell is a `WKWebView` pointed at the live site, so it has no
 * way to reach into the page and press a button. The home-screen entry points —
 * the Listen widget and the app icon's long-press quick action — instead
 * open the list at `/?action=listen`, and the page acts on it once on mount
 * (`src/lib/components/MainPage.svelte`). Keeping the vocabulary here is what
 * lets `native/App/OTBLaunchActions.swift` and the page agree on one spelling.
 *
 * Nothing else reads the param: the browsing state in the query string is
 * rebuilt from the recognised controls (see `list-url.ts`), so the first URL
 * sync after mount drops `action` from the address bar — the shortcut fires
 * once and a reload doesn't repeat it.
 */
export type LaunchAction = "listen";

/** The query param the native shell sets. */
export const LAUNCH_ACTION_PARAM = "action";

const LAUNCH_ACTIONS: readonly LaunchAction[] = ["listen"];

/** Read the requested launch action out of a list URL, or null for anything else. */
export function parseLaunchAction(params: URLSearchParams): LaunchAction | null {
  const value = params.get(LAUNCH_ACTION_PARAM);
  return LAUNCH_ACTIONS.includes(value as LaunchAction) ? (value as LaunchAction) : null;
}

/** The path + query that asks the app to run `action` on open. */
export function buildLaunchActionHref(action: LaunchAction): string {
  return `/?${LAUNCH_ACTION_PARAM}=${action}`;
}

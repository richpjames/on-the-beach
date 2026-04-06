/**
 * Client-side router for seamless audio-preserving navigation.
 *
 * Strategy: show/hide rather than replace.
 * - <main id="main"> stays in the DOM throughout (preserving all app.ts state/listeners).
 * - <div id="release-view"> is a sibling that receives fetched release-page content.
 * - #now-playing-player (the audio iframe container) is never touched.
 *
 * Dev server: /r/* is already handled by Hono SSR — fetch works as-is.
 * Production:  Hono serves /r/* via SSR and has a static catch-all; no nginx needed.
 */

let activeBackdropEl: HTMLElement | null = null;
let mainPageTitle: string = document.title;

function runScripts(sourceDoc: Document): void {
  // Execute inline scripts as type="module" so each has its own lexical scope.
  // Module scripts run asynchronously but DOM is already in place by the time they run.
  sourceDoc.body.querySelectorAll("script:not([src])").forEach((old) => {
    const el = document.createElement("script");
    el.type = "module";
    el.textContent = old.textContent ?? "";
    document.head.appendChild(el);
  });
}

async function navigateToRelease(path: string): Promise<void> {
  const main = document.getElementById("main") as HTMLElement | null;
  const releaseView = document.getElementById("release-view");
  if (!main || !releaseView) return;

  let res: Response;
  try {
    res = await fetch(path);
  } catch {
    return;
  }
  if (!res.ok) return;

  const doc = new DOMParser().parseFromString(await res.text(), "text/html");
  const remoteMain = doc.querySelector("main");
  if (!remoteMain) return;

  // Backdrop (release pages with artwork inject a fixed bg element directly in <body>)
  activeBackdropEl?.remove();
  activeBackdropEl = null;
  const backdrop = doc.querySelector<HTMLElement>(".release-page__backdrop");
  if (backdrop) {
    activeBackdropEl = backdrop.cloneNode(true) as HTMLElement;
    document.body.insertBefore(activeBackdropEl, document.body.firstChild);
  }

  releaseView.innerHTML = remoteMain.innerHTML;
  const remoteTitle = doc.querySelector("title");
  if (remoteTitle) document.title = remoteTitle.textContent ?? mainPageTitle;
  document.body.classList.toggle(
    "release-page-body",
    doc.body.classList.contains("release-page-body"),
  );
  main.hidden = true;
  releaseView.hidden = false;
  const footer = document.querySelector<HTMLElement>(".footer");
  if (footer) footer.hidden = true;

  runScripts(doc);
}

function navigateToMain(): void {
  const main = document.getElementById("main") as HTMLElement | null;
  const releaseView = document.getElementById("release-view");
  if (!main || !releaseView) return;

  releaseView.hidden = true;
  releaseView.innerHTML = "";
  activeBackdropEl?.remove();
  activeBackdropEl = null;
  document.title = mainPageTitle;
  document.body.classList.remove("release-page-body");
  main.hidden = false;
  const footer = document.querySelector<HTMLElement>(".footer");
  if (footer) footer.hidden = false;
  document.dispatchEvent(new CustomEvent("navigated-to-main"));
}

function handleClick(e: MouseEvent): void {
  const a = (e.target as Element).closest<HTMLAnchorElement>("a[href]");
  if (!a) return;
  let url: URL;
  try {
    url = new URL(a.href, location.href);
  } catch {
    return;
  }
  if (url.hostname !== location.hostname) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (a.target && a.target !== "_self") return;

  const { pathname } = url;
  if (/^\/r\/\d+/.test(pathname)) {
    e.preventDefault();
    history.pushState({}, "", pathname);
    void navigateToRelease(pathname);
  } else if (pathname === "/") {
    // Only intercept the back-link when we're already in the release view
    if (!document.getElementById("release-view")?.hidden) {
      e.preventDefault();
      history.pushState({}, "", pathname);
      navigateToMain();
    }
  }
}

function handlePopstate(): void {
  const { pathname } = location;
  if (/^\/r\/\d+/.test(pathname)) {
    void navigateToRelease(pathname);
    return;
  }
  navigateToMain();
  const stackMatch = pathname.match(/^\/s\/(\d+)\//);
  document.dispatchEvent(
    new CustomEvent("navigate-to-stack", {
      detail: { stackId: stackMatch ? Number(stackMatch[1]) : null },
    }),
  );
}

export function initRouter(): void {
  document.addEventListener("click", handleClick);
  window.addEventListener("popstate", handlePopstate);
}

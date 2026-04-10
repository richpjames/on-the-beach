import { Hono, type Context } from "hono";
import { eq, inArray, count, asc, desc } from "drizzle-orm";
import { db } from "../db/index";
import { musicItems, musicItemStacks, stacks, musicItemOrder, stackParents } from "../db/schema";
import { fullItemSelect, hydrateItemStacks } from "../music-item-creator";
import { applyOrder, buildContextKey } from "../../shared/music-list-context";
import { renderPrimaryFeedAlternateLinks, renderStackFeedAlternateLinks } from "../../shared/rss";
import { renderMusicList } from "../../src/ui/view/templates";
import type { MusicItemFull, StackWithCount } from "../../src/types";
import { getPageAssets } from "../page-assets";
import pkg from "../../package.json";

const DEFAULT_FILTER = "to-listen" as const;

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function safeJson(obj: unknown): string {
  return JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function renderStackTab(stack: StackWithCount): string {
  return `<button class="stack-tab" data-stack-id="${stack.id}">${escapeHtml(stack.name)}</button>`;
}

async function fetchInitialStacks(): Promise<StackWithCount[]> {
  const rows = await db
    .select({
      id: stacks.id,
      name: stacks.name,
      created_at: stacks.createdAt,
      item_count: count(musicItemStacks.musicItemId),
    })
    .from(stacks)
    .leftJoin(musicItemStacks, eq(stacks.id, musicItemStacks.stackId))
    .groupBy(stacks.id)
    .orderBy(asc(stacks.name));

  const parentRows = await db
    .select({
      parent_stack_id: stackParents.parentStackId,
      child_stack_id: stackParents.childStackId,
    })
    .from(stackParents);

  const parentsByChild = new Map<number, number[]>();
  for (const r of parentRows) {
    const existing = parentsByChild.get(r.child_stack_id) ?? [];
    existing.push(r.parent_stack_id);
    parentsByChild.set(r.child_stack_id, existing);
  }

  return rows.map((row) => ({
    ...row,
    parent_stack_ids: parentsByChild.get(row.id) ?? [],
  }));
}

async function fetchInitialItems(): Promise<MusicItemFull[]> {
  const items = await fullItemSelect()
    .where(eq(musicItems.listenStatus, DEFAULT_FILTER))
    .orderBy(desc(musicItems.createdAt), desc(musicItems.id));

  if (items.length === 0) return [];

  const stackRows = await db
    .select({
      musicItemId: musicItemStacks.musicItemId,
      id: stacks.id,
      name: stacks.name,
    })
    .from(musicItemStacks)
    .innerJoin(stacks, eq(stacks.id, musicItemStacks.stackId))
    .where(
      inArray(
        musicItemStacks.musicItemId,
        items.map((i) => i.id),
      ),
    );

  const enriched = hydrateItemStacks(items, stackRows);

  const contextKey = buildContextKey(DEFAULT_FILTER, null);
  const orderRow = await db
    .select()
    .from(musicItemOrder)
    .where(eq(musicItemOrder.contextKey, contextKey))
    .get();

  if (orderRow) {
    const parsed = JSON.parse(orderRow.itemIds);
    if (Array.isArray(parsed) && parsed.length > 0) {
      if (typeof parsed[0] === "number") {
        return applyOrder(enriched, parsed as number[]) as unknown as MusicItemFull[];
      }
      const itemIds = (parsed as string[])
        .filter((e: string) => e.startsWith("i:"))
        .map((e: string) => Number(e.slice(2)));
      return applyOrder(enriched, itemIds) as unknown as MusicItemFull[];
    }
  }

  return enriched as unknown as MusicItemFull[];
}

function renderMainPage(opts: {
  musicListHtml: string;
  stackBarTabsHtml: string;
  stacksJson: string;
  cssHref: string;
  scriptSrc: string;
  primaryRssAlternateLinksHtml: string;
  rssAlternateLinksHtml: string;
  isDev: boolean;
  appVersion: string;
}): string {
  const viteClient = opts.isDev ? `\n    <script type="module" src="/@vite/client"></script>` : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="Track music you want to listen to" />
    <meta name="robots" content="noindex, nofollow" />
    <title>On The Beach</title>
    <link rel="preconnect" href="https://fonts.coollabs.io" />
    <link
      href="https://fonts.coollabs.io/css2?family=VT323&family=Share+Tech+Mono&display=swap"
      rel="stylesheet"
    />
    <link rel="icon" href="/favicon.ico" sizes="48x48" />
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
    <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="manifest" href="/site.webmanifest" />
    ${opts.primaryRssAlternateLinksHtml}
    ${opts.rssAlternateLinksHtml}
    <link rel="stylesheet" href="${escapeHtml(opts.cssHref)}" />
  </head>
  <body>
      <header class="header">
        <h1>On The Beach</h1>
        <p class="header__subtitle">Music Tracking</p>
        <div class="header__winbuttons">
          <button class="header__winbtn" aria-label="Minimize" tabindex="-1">_</button>
          <button class="header__winbtn" aria-label="Maximize" tabindex="-1">□</button>
          <button class="header__winbtn header__winbtn--close" aria-label="Close" tabindex="-1">
            ✕
          </button>
        </div>
      </header>

      <main id="main" class="main">
        <section class="add-section">
          <form id="add-form" class="add-form" method="post">
            <div class="add-form__primary">
              <input
                type="text"
                id="url-input"
                name="url"
                placeholder="search or paste a link"
                class="input"
              />
              <input
                type="file"
                id="scan-file-input"
                class="add-form__scan-input"
                accept="image/*"
              />
              <button
                type="button"
                id="add-form-scan-btn"
                class="btn add-form__scan-btn"
                aria-label="Scan release cover"
              >
                Photo
              </button>
              <button
                type="button"
                id="add-form-recognize-btn"
                class="btn add-form__recognize-btn"
                aria-label="Identify playing song"
              >
                Listen
              </button>
              <button type="submit" id="add-form-submit" class="btn btn--primary">Add</button>
            </div>

            <div class="add-form__secondary" hidden>
              <input type="text" name="artist" placeholder="Artist" class="input" />
              <input type="text" name="title" placeholder="Release" class="input" />
              <select name="itemType" class="input">
                <option value="album">Release</option>
                <option value="ep">EP</option>
                <option value="single">Single</option>
                <option value="track">Track</option>
                <option value="mix">Mix</option>
              </select>

              <details class="add-form__details">
                <summary>Add more details</summary>
                <div class="add-form__extra">
                <input type="text" name="label" placeholder="Label" class="input" />
                <input
                  type="number"
                  name="year"
                  placeholder="Year"
                  min="1900"
                  max="2099"
                  class="input"
                />
                <input type="text" name="country" placeholder="Country" class="input" />
                <input type="text" name="genre" placeholder="Genre" class="input" />
                <input type="text" name="artworkUrl" placeholder="Artwork URL" class="input" />
                <input
                  type="text"
                  name="catalogueNumber"
                  placeholder="Catalogue number"
                  class="input"
                />
                <textarea name="notes" placeholder="Notes" class="input"></textarea>
                  <div class="stack-picker" id="add-form-stacks">
                    <div class="stack-picker__chips" id="add-form-stack-chips"></div>
                    <button
                      type="button"
                      class="stack-picker__add btn btn--ghost"
                      id="add-form-stack-btn"
                    >
                      + Stack
                    </button>
                  </div>
                </div>
              </details>
            </div>
          </form>
        </section>

        <section class="stack-section">
          <div class="stack-bar-shell">
            <div id="stack-bar" class="stack-bar">
              <button class="stack-tab active" data-stack="all">All</button>
              ${opts.stackBarTabsHtml}
              <button
                class="stack-tab stack-tab--manage"
                id="manage-stacks-btn"
                title="Manage stacks"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <circle cx="12" cy="12" r="3"></circle>
                  <path
                    d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
                  ></path>
                </svg>
              </button>
              <button
                class="stack-tab stack-tab--delete"
                id="delete-stack-btn"
                title="Delete selected stack"
                hidden
                aria-label="Delete selected stack"
              >
                🗑
              </button>
            </div>
            <div id="stack-bar-scrollbar" class="stack-scrollbar" aria-hidden="true">
              <button
                type="button"
                class="stack-scrollbar__button"
                data-stack-scroll-btn="left"
                tabindex="-1"
              >
                ◀
              </button>
              <div id="stack-bar-scroll-track" class="stack-scrollbar__track">
                <div id="stack-bar-scroll-thumb" class="stack-scrollbar__thumb"></div>
              </div>
              <button
                type="button"
                class="stack-scrollbar__button"
                data-stack-scroll-btn="right"
                tabindex="-1"
              >
                ▶
              </button>
            </div>
          </div>
          <div id="stack-manage" class="stack-manage" hidden>
            <div id="stack-manage-list"></div>
            <div class="stack-manage__create">
              <input
                type="text"
                id="stack-manage-input"
                class="input"
                placeholder="New stack name..."
              />
              <button type="button" id="stack-manage-create-btn" class="btn btn--primary">
                Create
              </button>
            </div>
          </div>
        </section>

        <section class="filter-section">
          <div class="browse-controls">
            <div id="filter-bar" class="filter-bar">
              <button class="filter-btn" data-filter="all">All</button>
              <button class="filter-btn active" data-filter="to-listen">To Listen</button>
              <button class="filter-btn" data-filter="listened">Listened</button>
              <button class="filter-btn" data-filter="scheduled">Scheduled</button>
            </div>
            <div class="browse-tools">
              <div class="browse-tools__mobile-actions">
                <button
                  type="button"
                  id="browse-search-toggle"
                  class="browse-tools__icon-btn"
                  aria-label="Toggle search"
                  aria-controls="browse-search-panel"
                  aria-expanded="false"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="10" cy="10" r="5.5"></circle>
                    <path d="M14.5 14.5L20 20"></path>
                    <path d="M7.5 10H12.5"></path>
                    <path d="M10 7.5V12.5"></path>
                  </svg>
                </button>
                <button
                  type="button"
                  id="browse-sort-toggle"
                  class="browse-tools__icon-btn"
                  aria-label="Toggle sort"
                  aria-controls="browse-sort-panel"
                  aria-expanded="false"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M8 4V20"></path>
                    <path d="M5 7L8 4L11 7"></path>
                    <path d="M16 20V4"></path>
                    <path d="M13 17L16 20L19 17"></path>
                  </svg>
                </button>
              </div>
              <div id="browse-search-panel" class="browse-tools__panel browse-tools__panel--search">
                <div class="browse-tools__search-wrap">
                  <input
                    type="search"
                    id="browse-search"
                    class="input browse-tools__search"
                    placeholder="Search releases or lists..."
                    aria-label="Search releases or lists"
                  />
                  <button
                    type="button"
                    id="search-clear-btn"
                    class="browse-tools__search-clear"
                    aria-label="Clear search"
                    style="display:none"
                  >&#x2715;</button>
                </div>
              </div>
              <div id="browse-sort-panel" class="browse-tools__panel browse-tools__panel--sort">
                <label class="browse-tools__sort" for="browse-sort">
                  <span>Sort</span>
                  <select id="browse-sort" class="input">
                    <option value="date-added">Date added</option>
                    <option value="date-listened" id="sort-option-date-listened" hidden>Date listened</option>
                    <option value="artist-name">Artist A–Z</option>
                    <option value="release-name">Release A–Z</option>
                    <option value="star-rating">Star rating</option>
                  </select>
                </label>
                <button
                  type="button"
                  id="sort-direction-btn"
                  class="btn btn--ghost browse-tools__direction-btn"
                  aria-label="Sort direction: newest first"
                  data-direction="desc"
                >↓ Newest first</button>
              </div>
            </div>
          </div>
        </section>

        <section class="list-section">
          <div class="music-list-shell">
            <div id="music-list" class="music-list">
              ${opts.musicListHtml}
            </div>
            <div id="music-list-scrollbar" class="music-scrollbar">
              <button
                type="button"
                class="music-scrollbar__button"
                data-scroll-btn="up"
                aria-label="Scroll up"
                tabindex="-1"
              >
                ▲
              </button>
              <div id="music-list-scroll-track" class="music-scrollbar__track">
                <div id="music-list-scroll-thumb" class="music-scrollbar__thumb"></div>
              </div>
              <button
                type="button"
                class="music-scrollbar__button"
                data-scroll-btn="down"
                aria-label="Scroll down"
                tabindex="-1"
              >
                ▼
              </button>
            </div>
          </div>
        </section>
      </main>
      <div id="link-picker-modal" class="link-picker" hidden>
        <div class="link-picker__backdrop" data-link-picker-close="true"></div>
        <div
          class="link-picker__dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="link-picker-title"
        >
          <div class="link-picker__header">
            <h2 id="link-picker-title">Pick releases</h2>
            <p id="link-picker-message">
              This link mentions several releases. Pick one or more to add.
            </p>
            <p id="link-picker-url" class="link-picker__url"></p>
          </div>
          <div class="link-picker__list-header">
            <button type="button" id="link-picker-select-all" class="btn btn--ghost">Select all</button>
          </div>
          <div class="link-picker__list-shell">
            <div id="link-picker-list" class="link-picker__list"></div>
            <div id="link-picker-scrollbar" class="music-scrollbar">
              <button
                type="button"
                class="music-scrollbar__button"
                data-link-picker-scroll-btn="up"
                aria-label="Scroll up"
                tabindex="-1"
              >
                ▲
              </button>
              <div id="link-picker-scroll-track" class="music-scrollbar__track">
                <div id="link-picker-scroll-thumb" class="music-scrollbar__thumb"></div>
              </div>
              <button
                type="button"
                class="music-scrollbar__button"
                data-link-picker-scroll-btn="down"
                aria-label="Scroll down"
                tabindex="-1"
              >
                ▼
              </button>
            </div>
          </div>
          <div class="link-picker__actions">
            <button type="button" id="link-picker-cancel" class="btn btn--ghost">Cancel</button>
            <button type="button" id="link-picker-manual" class="btn btn--ghost">
              Enter manually
            </button>
            <button type="button" id="link-picker-submit" class="btn btn--primary" disabled>
              Add selected
            </button>
          </div>
        </div>
      </div>
      <div id="suggestion-picker-modal" class="link-picker" hidden>
        <div class="link-picker__backdrop" data-suggestion-picker-close="true"></div>
        <div
          class="link-picker__dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="suggestion-picker-title"
        >
          <div class="link-picker__header">
            <h2 id="suggestion-picker-title">You might also like</h2>
            <p id="suggestion-picker-message"></p>
          </div>
          <div id="suggestion-picker-list" class="link-picker__list" style="overflow-y: visible"></div>
          <div class="link-picker__actions">
            <button type="button" id="suggestion-picker-dismiss" class="btn btn--ghost">Dismiss</button>
            <button type="button" id="suggestion-picker-accept" class="btn btn--primary">
              Add to list
            </button>
          </div>
        </div>
      </div>
      <footer class="footer">
        <span id="app-version">v${escapeHtml(opts.appVersion)}</span>
      </footer>

      <div id="release-modal" class="release-modal" hidden>
        <div class="release-modal__overlay"></div>
        <div class="release-modal__window">
          <div class="release-modal__titlebar">
            <span class="release-modal__titlebar-icon" aria-hidden="true">💿</span>
            <span id="release-modal-title" class="release-modal__title"></span>
            <button id="release-modal-close" class="release-modal__winbtn release-modal__winbtn--close" aria-label="Close">✕</button>
          </div>
          <div id="release-modal-body" class="release-modal__body"></div>
        </div>
      </div>

      <div id="now-playing-player" class="player-window" hidden aria-hidden="true">
        <div class="player-window__titlebar" id="player-titlebar">
          <span class="player-window__icon" aria-hidden="true">♫</span>
          <span class="player-window__title" id="player-title-text">Now Playing</span>
          <div class="player-window__winbtns">
            <button class="player-window__winbtn" id="player-minimize" aria-label="Minimize" title="Minimize">_</button>
            <button class="player-window__winbtn player-window__winbtn--close" id="player-close" aria-label="Stop playback" title="Close">✕</button>
          </div>
        </div>
        <div class="player-window__body" id="player-body"></div>
      </div>

      <!-- Persistent release-page view: populated by src/router.ts on SPA navigation -->
      <div id="release-view" hidden></div>

      <div id="add-loading-overlay" class="add-loading-overlay" aria-hidden="true">
        <div
          class="add-loading-dialog"
          role="alertdialog"
          aria-labelledby="add-loading-title"
          aria-describedby="add-loading-status"
        >
          <div class="add-loading-dialog__titlebar">
            <span class="add-loading-dialog__titlebar-icon" aria-hidden="true">💿</span>
            <span class="add-loading-dialog__title" id="add-loading-title">On The Beach</span>
            <div class="add-loading-dialog__winbtns" aria-hidden="true">
              <button class="add-loading-dialog__winbtn" tabindex="-1" disabled>_</button>
              <button class="add-loading-dialog__winbtn" tabindex="-1" disabled>□</button>
              <button
                class="add-loading-dialog__winbtn add-loading-dialog__winbtn--close"
                tabindex="-1"
                disabled
              >
                ✕
              </button>
            </div>
          </div>
          <div class="add-loading-dialog__body">
            <div class="add-loading-dialog__content">
              <p class="add-loading-dialog__status" id="add-loading-status">
                Adding to collection...
              </p>
              <div
                class="add-loading-dialog__progress"
                role="progressbar"
                aria-label="Adding release"
                aria-busy="true"
              >
                <div class="add-loading-dialog__progress-fill"></div>
              </div>
              <p class="add-loading-dialog__substatus" aria-hidden="true">Please wait...</p>
            </div>
          </div>
          <div class="add-loading-dialog__footer">
            <button class="btn" disabled>Cancel</button>
          </div>
        </div>
      </div>

    <div id="taskbar">
      <button id="taskbar-start" class="taskbar__start">🪟 Start</button>
      <button id="taskbar-np-btn" class="taskbar__task" hidden>
        <span aria-hidden="true">♫</span>
        <span id="taskbar-np-label"></span>
      </button>
      <span id="taskbar-clock" class="taskbar__clock"></span>
    </div>
    <script id="__initial_state__" type="application/json">${opts.stacksJson}</script>${viteClient}
    <script type="module" src="${escapeHtml(opts.scriptSrc)}"></script>
  </body>
</html>`;
}

export function createMainPageRoutes(): Hono {
  const routes = new Hono();
  const isDev = process.env.NODE_ENV !== "production";

  async function serveMainPage(c: Context) {
    const [initialItems, initialStacks, { cssHref, scriptSrc }] = await Promise.all([
      fetchInitialItems(),
      fetchInitialStacks(),
      getPageAssets(),
    ]);

    const musicListHtml = renderMusicList(initialItems, DEFAULT_FILTER, "");
    const stackBarTabsHtml = initialStacks.map((s) => renderStackTab(s)).join("");
    const stacksJson = safeJson({ stacks: initialStacks });
    const primaryRssAlternateLinksHtml = renderPrimaryFeedAlternateLinks();
    const rssAlternateLinksHtml = renderStackFeedAlternateLinks(initialStacks);

    return c.html(
      renderMainPage({
        musicListHtml,
        stackBarTabsHtml,
        stacksJson,
        cssHref,
        scriptSrc,
        primaryRssAlternateLinksHtml,
        rssAlternateLinksHtml,
        isDev,
        appVersion: pkg.version,
      }),
    );
  }

  routes.get("/", serveMainPage);
  routes.get("/s/:id/:name", serveMainPage);

  return routes;
}

export const mainPageRoutes = createMainPageRoutes();

import { Hono } from "hono";
import { eq, inArray, count, asc, desc } from "drizzle-orm";
import { db } from "../db/index";
import { musicItems, musicItemStacks, stacks, musicItemOrder, stackParents } from "../db/schema";
import { fullItemSelect, hydrateItemStacks } from "../music-item-creator";
import { applyOrder, buildContextKey } from "../../shared/music-list-context";
import {
  buildPrimaryFeedHref,
  buildPrimaryFeedTitle,
  buildStackFeedHref,
  buildStackFeedTitle,
  PRIMARY_FEEDS,
} from "../../shared/rss";
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

export function renderPrimaryFeedAlternateLinks(): string {
  return PRIMARY_FEEDS.map(
    (feed) =>
      `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(buildPrimaryFeedTitle(feed.key))}" href="${escapeHtml(buildPrimaryFeedHref(feed.key))}" />`,
  ).join("\n    ");
}

export function renderStackFeedAlternateLinks(
  stacks: Pick<StackWithCount, "id" | "name">[],
): string {
  return stacks
    .map(
      (stack) =>
        `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(buildStackFeedTitle(stack.name))}" href="${escapeHtml(buildStackFeedHref(stack.id))}" data-rss-feed-link="${stack.id}" />`,
    )
    .join("\n    ");
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

  const parentByChild = new Map(parentRows.map((r) => [r.child_stack_id, r.parent_stack_id]));

  return rows.map((row) => ({
    ...row,
    parent_stack_id: parentByChild.get(row.id) ?? null,
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
    const orderedIds = JSON.parse(orderRow.itemIds) as number[];
    return applyOrder(enriched, orderedIds) as unknown as MusicItemFull[];
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

      <main class="main">
        <section class="add-section">
          <form id="add-form" class="add-form" method="post">
            <div class="add-form__primary">
              <input
                type="text"
                id="url-input"
                name="url"
                placeholder="Paste a music link..."
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
                Scan
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
          <div id="filter-bar" class="filter-bar">
            <button class="filter-btn" data-filter="all">All</button>
            <button class="filter-btn active" data-filter="to-listen">To Listen</button>
            <button class="filter-btn" data-filter="listened">Listened</button>
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
            <h2 id="link-picker-title">Pick a release</h2>
            <p id="link-picker-message">
              This link mentions several releases. Choose one to add.
            </p>
            <p id="link-picker-url" class="link-picker__url"></p>
          </div>
          <div id="link-picker-list" class="link-picker__list"></div>
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
      <footer class="footer">
        <span id="app-version">v${escapeHtml(opts.appVersion)}</span>
      </footer>

    <script id="__initial_state__" type="application/json">${opts.stacksJson}</script>${viteClient}
    <script type="module" src="${escapeHtml(opts.scriptSrc)}"></script>
  </body>
</html>`;
}

export function createMainPageRoutes(): Hono {
  const routes = new Hono();
  const isDev = process.env.NODE_ENV !== "production";

  routes.get("/", async (c) => {
    const [initialItems, initialStacks, { cssHref, scriptSrc }] = await Promise.all([
      fetchInitialItems(),
      fetchInitialStacks(),
      getPageAssets(),
    ]);

    const musicListHtml = renderMusicList(initialItems, DEFAULT_FILTER);
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
  });

  return routes;
}

export const mainPageRoutes = createMainPageRoutes();

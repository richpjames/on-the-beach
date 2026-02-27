import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fetchFullItem } from "../music-item-creator";
import type { MusicItemFull } from "../../src/types";

export type FetchItemFn = (id: number) => Promise<MusicItemFull | null>;

let cssHrefCache: string | null = null;

async function getCssHref(): Promise<string> {
  if (process.env.NODE_ENV !== "production") {
    return "/src/styles/main.css";
  }
  if (cssHrefCache) return cssHrefCache;
  try {
    const html = await readFile(path.resolve("dist/index.html"), "utf-8");
    const match = html.match(/href="(\/assets\/[^"]+\.css)"/);
    cssHrefCache = match?.[1] ?? "/assets/index.css";
  } catch {
    cssHrefCache = "/assets/index.css";
  }
  return cssHrefCache;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

const SAFE_ARTWORK_URL = /^(https?:\/\/|\/uploads\/)/;

function safeArtworkUrl(url: string): string | null {
  return SAFE_ARTWORK_URL.test(url) ? url : null;
}

function renderNotFoundPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Not Found — On The Beach</title>
  </head>
  <body>
    <div id="app">
      <header class="header">
        <h1>On The Beach</h1>
        <p class="header__subtitle">Music Tracking</p>
      </header>
      <main class="main">
        <div class="release-page">
          <p>Not found — this release doesn't exist.</p>
          <a href="/" class="btn btn--ghost">← back to list</a>
        </div>
      </main>
    </div>
  </body>
</html>`;
}

function renderReleasePage(item: MusicItemFull, cssHref: string): string {
  const statusOptions = [
    { value: "to-listen", label: "To Listen" },
    { value: "listening", label: "Listening" },
    { value: "listened", label: "Listened" },
    { value: "done", label: "Done" },
  ]
    .map(
      ({ value, label }) =>
        `<option value="${value}"${item.listen_status === value ? " selected" : ""}>${label}</option>`,
    )
    .join("");

  const metaFields = [item.year ? String(item.year) : null, item.label, item.country, item.genre]
    .filter(Boolean)
    .map((s) => escapeHtml(s!))
    .join(" · ");

  const stackChips = item.stacks
    .map((s) => `<span class="music-card__stack-chip">${escapeHtml(s.name)}</span>`)
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${escapeHtml(item.title)} — On The Beach</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=VT323&family=Share+Tech+Mono&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="${escapeHtml(cssHref)}" />
  </head>
  <body>
    <div id="app">
      <header class="header">
        <h1>On The Beach</h1>
        <p class="header__subtitle">Music Tracking</p>
      </header>
      <main class="main">
        <div class="release-page">

          <div class="release-page__nav">
            <a href="/" class="btn btn--ghost">← back to list</a>
            <button type="button" class="btn" id="edit-btn">Edit</button>
          </div>

          ${safeArtworkUrl(item.artwork_url ?? "") ? `<img class="release-page__artwork" src="${escapeHtml(item.artwork_url!)}" alt="Artwork for ${escapeHtml(item.title)}" />` : ""}

          <div id="view-mode">
            <h2 class="release-page__title">${escapeHtml(item.title)}</h2>
            ${item.artist_name ? `<p class="release-page__artist">${escapeHtml(item.artist_name)}</p>` : ""}
            ${metaFields ? `<p class="release-page__meta">${metaFields}</p>` : ""}
            ${item.catalogue_number ? `<p class="release-page__catalogue">${escapeHtml(item.catalogue_number)}</p>` : ""}
            ${item.notes ? `<p class="release-page__notes">${escapeHtml(item.notes)}</p>` : ""}
          </div>

          <div id="edit-mode" hidden>
            <input class="input" type="text" id="edit-title" value="${escapeHtml(item.title)}" placeholder="Title" />
            <input class="input" type="text" id="edit-artist" value="${escapeHtml(item.artist_name ?? "")}" placeholder="Artist" />
            <div class="release-page__edit-row">
              <input class="input" type="number" id="edit-year" value="${item.year ?? ""}" placeholder="Year" min="1900" max="2099" />
              <input class="input" type="text" id="edit-label" value="${escapeHtml(item.label ?? "")}" placeholder="Label" />
              <input class="input" type="text" id="edit-country" value="${escapeHtml(item.country ?? "")}" placeholder="Country" />
            </div>
            <input class="input" type="text" id="edit-genre" value="${escapeHtml(item.genre ?? "")}" placeholder="Genre" />
            <input class="input" type="text" id="edit-catalogue" value="${escapeHtml(item.catalogue_number ?? "")}" placeholder="Catalogue number" />
            <textarea class="input" id="edit-notes" placeholder="Notes">${escapeHtml(item.notes ?? "")}</textarea>
            <div class="release-page__edit-actions">
              <button type="button" class="btn btn--primary" id="save-btn">Save changes</button>
              <button type="button" class="btn btn--ghost" id="cancel-btn">Cancel</button>
            </div>
          </div>

          <div class="release-page__status">
            <label for="status-select">Status</label>
            <select id="status-select" class="status-select">${statusOptions}</select>
          </div>

          ${stackChips ? `<div class="release-page__stacks">${stackChips}</div>` : ""}

          <div class="release-page__footer">
            <button type="button" class="btn btn--ghost btn--danger" id="delete-btn">Delete</button>
          </div>

        </div>
      </main>
    </div>
    <script>
      const ITEM_ID = ${item.id};

      document.getElementById('edit-btn').addEventListener('click', () => {
        document.getElementById('view-mode').hidden = true;
        document.getElementById('edit-mode').hidden = false;
        document.getElementById('edit-btn').hidden = true;
      });

      document.getElementById('cancel-btn').addEventListener('click', () => {
        document.getElementById('edit-mode').hidden = true;
        document.getElementById('view-mode').hidden = false;
        document.getElementById('edit-btn').hidden = false;
      });

      document.getElementById('save-btn').addEventListener('click', async () => {
        const yearVal = document.getElementById('edit-year').value;
        const body = {
          title: document.getElementById('edit-title').value.trim() || undefined,
          artistName: document.getElementById('edit-artist').value.trim() || undefined,
          year: yearVal ? Number(yearVal) : null,
          label: document.getElementById('edit-label').value.trim() || null,
          country: document.getElementById('edit-country').value.trim() || null,
          genre: document.getElementById('edit-genre').value.trim() || null,
          catalogueNumber: document.getElementById('edit-catalogue').value.trim() || null,
          notes: document.getElementById('edit-notes').value.trim() || null,
        };
        const res = await fetch('/api/music-items/' + ITEM_ID, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          window.location.reload();
        } else {
          alert('Failed to save changes.');
        }
      });

      document.getElementById('status-select').addEventListener('change', async (e) => {
        const res = await fetch('/api/music-items/' + ITEM_ID, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ listenStatus: e.target.value }),
        });
        if (!res.ok) alert('Failed to update status.');
      });

      document.getElementById('delete-btn').addEventListener('click', async () => {
        if (!confirm('Delete this release?')) return;
        const res = await fetch('/api/music-items/' + ITEM_ID, { method: 'DELETE' });
        if (res.ok) window.location.href = '/';
      });
    </script>
  </body>
</html>`;
}

export function createReleasePageRoutes(fetchItem: FetchItemFn = fetchFullItem): Hono {
  const routes = new Hono();

  routes.get("/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (Number.isNaN(id)) {
      return c.text("Invalid ID", 400);
    }

    let item: MusicItemFull | null;
    try {
      item = await fetchItem(id);
    } catch (err) {
      console.error("[release-page] GET /r/:id fetchItem error:", err);
      return c.html(renderNotFoundPage(), 500);
    }

    if (!item) {
      return c.html(renderNotFoundPage(), 404);
    }

    const cssHref = await getCssHref();
    return c.html(renderReleasePage(item, cssHref));
  });

  return routes;
}

export const releasePageRoutes = createReleasePageRoutes();

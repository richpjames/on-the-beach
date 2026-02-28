import { Hono } from "hono";
import { fetchFullItem } from "../music-item-creator";
import type { MusicItemFull } from "../../src/types";
import { getPageAssets } from "../page-assets";

export type FetchItemFn = (id: number) => Promise<MusicItemFull | null>;

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
            <a href="/" class="btn">← back to list</a>
          </div>

          ${safeArtworkUrl(item.artwork_url ?? "") ? `<img class="release-page__artwork" src="${escapeHtml(item.artwork_url!)}" alt="Artwork for ${escapeHtml(item.title)}" />` : ""}

          <div id="view-mode">
            <h2 class="release-page__title">${escapeHtml(item.title)}</h2>
            ${item.artist_name ? `<p class="release-page__artist">${escapeHtml(item.artist_name)}</p>` : ""}
            ${metaFields ? `<p class="release-page__meta">${metaFields}</p>` : ""}
            ${item.catalogue_number ? `<p class="release-page__catalogue">${escapeHtml(item.catalogue_number)}</p>` : ""}
            ${item.notes ? `<p class="release-page__notes">${escapeHtml(item.notes)}</p>` : ""}
            ${item.rating !== null ? `<p class="release-page__rating">${"★".repeat(item.rating)}${"☆".repeat(5 - item.rating)}</p>` : ""}
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
              <button type="button" class="btn" id="cancel-btn">Cancel</button>
            </div>
          </div>

          <div class="release-page__status">
            <label for="status-select">Status</label>
            <select id="status-select" class="status-select">${statusOptions}</select>
          </div>

          <div class="release-page__stacks">
            <div id="stack-chips"></div>
            <div class="release-page__stack-adder">
              <button type="button" class="btn stack-picker__add" id="stack-picker-toggle">+ Stack</button>
              <div class="stack-dropdown" id="stack-picker" hidden>
                <div id="stack-picker-list"></div>
                <div class="stack-dropdown__new">
                  <input type="text" class="input stack-dropdown__new-input" id="new-stack-input" placeholder="New stack…" />
                </div>
              </div>
            </div>
          </div>

          <div class="release-page__footer">
            <button type="button" class="btn" id="edit-btn">Edit</button>
            <button type="button" class="btn" id="delete-btn">Delete</button>
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
        document.getElementById('delete-btn').hidden = true;
      });

      document.getElementById('cancel-btn').addEventListener('click', () => {
        document.getElementById('edit-mode').hidden = true;
        document.getElementById('view-mode').hidden = false;
        document.getElementById('edit-btn').hidden = false;
        document.getElementById('delete-btn').hidden = false;
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

      // ── Stacks ──────────────────────────────────────────────────────────────
      let allStacks = [];
      const assignedIds = new Set(${JSON.stringify(item.stacks.map((s) => s.id))});

      function htmlEsc(str) {
        return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      }

      function renderStackChips() {
        const el = document.getElementById('stack-chips');
        const assigned = allStacks.filter(s => assignedIds.has(s.id));
        el.innerHTML = assigned.map(s =>
          '<span class="stack-chip">' + htmlEsc(s.name) +
          '<button type="button" class="stack-chip__remove" data-sid="' + s.id + '" title="Remove">×</button>' +
          '</span>'
        ).join('');
        el.querySelectorAll('.stack-chip__remove').forEach(btn => {
          btn.addEventListener('click', () => toggleStack(parseInt(btn.dataset.sid), false));
        });
      }

      function renderStackPicker() {
        const el = document.getElementById('stack-picker-list');
        el.innerHTML = allStacks.map(s =>
          '<label class="stack-dropdown__item">' +
          '<input type="checkbox" class="stack-dropdown__checkbox" data-sid="' + s.id + '"' +
          (assignedIds.has(s.id) ? ' checked' : '') + '> ' +
          htmlEsc(s.name) + '</label>'
        ).join('');
        el.querySelectorAll('.stack-dropdown__checkbox').forEach(cb => {
          cb.addEventListener('change', () => toggleStack(parseInt(cb.dataset.sid), cb.checked));
        });
      }

      async function toggleStack(stackId, add) {
        const method = add ? 'PUT' : 'DELETE';
        const res = await fetch('/api/stacks/items/' + ITEM_ID + '/' + stackId, { method });
        if (res.ok) {
          add ? assignedIds.add(stackId) : assignedIds.delete(stackId);
          renderStackChips();
          renderStackPicker();
        }
      }

      async function loadStacks() {
        const res = await fetch('/api/stacks');
        if (res.ok) { allStacks = await res.json(); renderStackChips(); renderStackPicker(); }
      }

      document.getElementById('stack-picker-toggle').addEventListener('click', e => {
        e.stopPropagation();
        const picker = document.getElementById('stack-picker');
        picker.hidden = !picker.hidden;
        if (!picker.hidden) document.getElementById('new-stack-input').focus();
      });

      document.addEventListener('click', () => {
        document.getElementById('stack-picker').hidden = true;
      });

      document.getElementById('stack-picker').addEventListener('click', e => e.stopPropagation());

      document.getElementById('new-stack-input').addEventListener('keydown', async e => {
        if (e.key !== 'Enter') return;
        const name = e.target.value.trim();
        if (!name) return;
        const res = await fetch('/api/stacks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        });
        if (res.ok) {
          const stack = await res.json();
          e.target.value = '';
          allStacks.push(stack);
          await toggleStack(stack.id, true);
        }
      });

      loadStacks();
    </script>
  </body>
</html>`;
}

export function createReleasePageRoutes(fetchItem: FetchItemFn = fetchFullItem): Hono {
  const routes = new Hono();

  routes.get("/:id", async (c) => {
    const rawId = c.req.param("id");
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) {
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

    const { cssHref } = await getPageAssets();
    return c.html(renderReleasePage(item, cssHref));
  });

  return routes;
}

export const releasePageRoutes = createReleasePageRoutes();

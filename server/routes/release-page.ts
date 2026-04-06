import { Hono } from "hono";
import { fetchFullItem } from "../music-item-creator";
import type { MusicItemFull } from "../../src/types";
import { getPageAssets } from "../page-assets";
import { renderStarRating } from "../../src/ui/view/templates";
import { parseUrl, extractYouTubeVideoId, extractYouTubePlaylistId } from "../utils";

export type FetchItemFn = (id: number) => Promise<MusicItemFull | null>;

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

const SOURCE_DISPLAY_NAMES: Record<string, string> = {
  bandcamp: "Bandcamp",
  spotify: "Spotify",
  soundcloud: "SoundCloud",
  youtube: "YouTube",
  apple_music: "Apple Music",
  discogs: "Discogs",
  tidal: "Tidal",
  deezer: "Deezer",
  mixcloud: "Mixcloud",
  physical: "Physical",
  unknown: "Link",
};

function sourceDisplayName(source: string): string {
  return SOURCE_DISPLAY_NAMES[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
}

const SAFE_ARTWORK_URL = /^(https?:\/\/|\/uploads\/)/;

function safeArtworkUrl(url: string): string | null {
  return SAFE_ARTWORK_URL.test(url) ? url : null;
}

function parseLinkMetadata(raw: string | null): Record<string, string> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // ignore malformed JSON
  }
  return null;
}

function youTubeEmbedSrc(url: string): string | null {
  const videoId = extractYouTubeVideoId(url);
  if (videoId && /^[\w-]+$/.test(videoId)) {
    return `https://www.youtube-nocookie.com/embed/${escapeHtml(videoId)}`;
  }
  const playlistId = extractYouTubePlaylistId(url);
  if (playlistId && /^[\w-]+$/.test(playlistId)) {
    return `https://www.youtube-nocookie.com/embed/videoseries?list=${escapeHtml(playlistId)}`;
  }
  return null;
}

function youTubePlayerAttrs(item: MusicItemFull): string {
  const src = item.primary_url ? youTubeEmbedSrc(item.primary_url) : null;
  if (!src) return "";
  return ` data-src="${src}" data-title="${escapeHtml(item.title)}" data-artist="${escapeHtml(item.artist_name ?? "")}" data-player-type="video"`;
}

function renderYouTubeButton(item: MusicItemFull): string {
  const attrs = youTubePlayerAttrs(item);
  if (!attrs) return "";
  return `<button class="release-page__listen-btn"${attrs}>▶ Watch</button>`;
}

function renderBandcampEmbed(item: MusicItemFull): string {
  const meta = parseLinkMetadata(item.primary_link_metadata);
  const albumId = meta?.album_id;
  if (!albumId) return "";

  const embedType = meta.item_type === "track" ? "track" : "album";
  const src = `https://bandcamp.com/EmbeddedPlayer/${escapeHtml(embedType)}=${escapeHtml(albumId)}/size=large/bgcol=ffffff/linkcol=0687f5/artwork=none/transparent=true/`;

  const title = escapeHtml(item.title);
  const artist = escapeHtml(item.artist_name ?? "");

  return `<button
    class="release-page__listen-btn"
    data-src="${src}"
    data-title="${title}"
    data-artist="${artist}"
  >▶ Listen</button>`;
}

function renderAppleMusicButton(item: MusicItemFull): string {
  if (!item.primary_url) return "";
  try {
    const parsed = new URL(item.primary_url);
    if (!parsed.hostname.endsWith("music.apple.com")) return "";
    const src = `https://embed.music.apple.com${parsed.pathname}`;
    const title = escapeHtml(item.title);
    const artist = escapeHtml(item.artist_name ?? "");
    return `<button
    class="release-page__listen-btn"
    data-src="${escapeHtml(src)}"
    data-title="${title}"
    data-artist="${artist}"
  >▶ Listen</button>`;
  } catch {
    return "";
  }
}

function renderMixcloudEmbedFromMetadata(item: MusicItemFull): string {
  const meta = parseLinkMetadata(item.primary_link_metadata);
  const mixcloudUrl = meta?.mixcloud_url;
  if (!mixcloudUrl) return "";

  let pathname: string;
  try {
    const parsed = new URL(mixcloudUrl);
    if (!parsed.hostname.toLowerCase().endsWith("mixcloud.com")) return "";
    pathname = parsed.pathname;
  } catch {
    return "";
  }

  const widgetSrc = `https://www.mixcloud.com/widget/iframe/?hide_cover=1&feed=${encodeURIComponent(pathname)}`;

  return `<iframe
    class="release-page__mixcloud-embed"
    src="${escapeHtml(widgetSrc)}"
    style="border:0;width:100%;height:60px;"
    title="Mixcloud player"
    allow="autoplay"
  ></iframe>`;
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
    <header class="header">
      <h1>On The Beach</h1>
      <p class="header__subtitle">Music Tracking</p>
    </header>
    <main class="main">
      <div class="release-page">
        <p>Not found — this release doesn't exist.</p>
        <a href="/" class="btn btn--ghost">◄</a>
      </div>
    </main>
  </body>
</html>`;
}

function reminderDateValue(item: MusicItemFull): string {
  if (item.remind_at) {
    const d = new Date(item.remind_at as unknown as string | Date);
    return d.toISOString().slice(0, 10);
  }
  if (item.year) {
    return `${item.year}-01-01`;
  }
  return "";
}

function renderReleasePage(item: MusicItemFull, cssHref: string): string {
  const statusOptions = [
    { value: "to-listen", label: "To Listen" },
    { value: "listened", label: "Listened" },
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
    <link rel="preconnect" href="https://fonts.coollabs.io" />
    <link href="https://fonts.coollabs.io/css2?family=VT323&family=Share+Tech+Mono&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="${escapeHtml(cssHref)}" />
  </head>
  <body class="release-page-body">
    ${safeArtworkUrl(item.artwork_url ?? "") ? `<div class="release-page__backdrop" style="background-image: url('${escapeHtml(item.artwork_url!)}')"></div>` : ""}
    <header class="header">
      <h1>On The Beach</h1>
      <p class="header__subtitle">Music Tracking</p>
    </header>
    <main class="main">
      <div class="release-page">

          <div class="release-page__nav">
            <a href="/" class="btn">◄</a>
          </div>

          <div class="release-page__body">

            ${safeArtworkUrl(item.artwork_url ?? "") ? (item.primary_source === "youtube" ? `<button class="release-page__artwork-play release-page__listen-btn"${youTubePlayerAttrs(item)}><img class="release-page__artwork" src="${escapeHtml(item.artwork_url!)}" alt="Artwork for ${escapeHtml(item.title)}" /></button>` : `<img class="release-page__artwork" src="${escapeHtml(item.artwork_url!)}" alt="Artwork for ${escapeHtml(item.title)}" />`) : ""}

            <div class="release-page__content">

              <div id="view-mode">
                <h2 class="release-page__title">${escapeHtml(item.title)}</h2>
                ${item.artist_name ? `<p class="release-page__artist">${escapeHtml(item.artist_name)}</p>` : ""}
                ${metaFields ? `<p class="release-page__meta">${metaFields}</p>` : ""}
                ${item.catalogue_number ? `<p class="release-page__catalogue">${escapeHtml(item.catalogue_number)}</p>` : ""}
                ${item.notes ? `<p class="release-page__notes">${escapeHtml(item.notes)}</p>` : ""}
                ${renderStarRating(item.id, item.rating, "star-rating--large")}
                ${item.primary_url && !item.primary_url.includes("bandcamp.com") ? `<a class="release-page__source-link" href="${escapeHtml(item.primary_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(sourceDisplayName(item.primary_source ?? parseUrl(item.primary_url).source))}</a>` : ""}
                ${item.primary_url?.includes("bandcamp.com") ? renderBandcampEmbed(item) : ""}
                ${item.primary_source === "youtube" ? renderYouTubeButton(item) : ""}
                ${item.primary_url?.includes("music.apple.com") ? renderAppleMusicButton(item) : ""}
                ${renderMixcloudEmbedFromMetadata(item)}
                <div id="secondary-links"></div>
                ${item.links
                  .filter((l) => !l.is_primary)
                  .map(
                    (l) =>
                      `<a class="release-page__source-link" href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.display_name ?? l.source_name ?? "Link")}</a>`,
                  )
                  .join("")}
              </div>

              <div id="edit-mode" hidden>
                <div class="release-page__edit-fields">
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
                  <div class="release-page__edit-artwork">
                    <input type="file" id="artwork-file-input" accept="image/*" style="display:none" />
                    <button type="button" class="btn" id="artwork-upload-btn">Replace image</button>
                    <input class="input" type="text" id="edit-artwork-url" value="${escapeHtml(item.artwork_url ?? "")}" placeholder="Artwork URL" />
                  </div>
                  <div class="release-page__edit-links">
                    <div class="release-page__edit-stacks-header">Links</div>
                    <div id="link-list"></div>
                    <div class="release-page__edit-link-add">
                      <div class="release-page__source-picker">
                        <input class="input" type="text" id="link-source-input" placeholder="Source" autocomplete="off" />
                        <div id="source-dropdown" class="release-page__source-dropdown" hidden></div>
                      </div>
                      <input class="input" type="url" id="link-url-input" placeholder="URL" />
                      <button type="button" class="btn" id="add-link-btn">Add</button>
                    </div>
                  </div>
                  <div class="release-page__edit-actions">
                    <button type="button" class="btn btn--primary" id="save-btn">Save changes</button>
                    <button type="button" class="btn" id="cancel-btn">Cancel</button>
                  </div>
                </div>
              </div>

              <div class="release-page__edit-stacks">
                <div class="release-page__edit-stacks-header">Stacks</div>
                <div id="stack-chips" class="release-page__stacks release-page__stacks--inline"></div>
                <div id="stack-picker-list" class="release-page__edit-stacks-list"></div>
                <div class="release-page__edit-stacks-new">
                  <input type="text" class="input stack-dropdown__new-input" id="new-stack-input" placeholder="New stack…" />
                </div>
              </div>

              <div class="release-page__status">
                <label for="status-select">Status</label>
                <select id="status-select" class="status-select">${statusOptions}</select>
              </div>

              <div class="release-page__reminder">
                <label for="remind-at">Remind me on</label>
                <input class="input" type="date" id="remind-at" value="${escapeHtml(reminderDateValue(item))}" />
                <button type="button" class="btn btn--primary" id="set-reminder-btn">Set reminder</button>
                ${item.remind_at ? `<button type="button" class="btn" id="clear-reminder-btn">Clear</button>` : ""}
              </div>

              <div class="release-page__footer">
                <button type="button" class="btn" id="edit-btn">Edit</button>
                <button type="button" class="btn" id="delete-btn">Delete</button>
              </div>

            </div>
          </div>

      </div>
    </main>
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
    <div id="taskbar">
      <button id="taskbar-np-btn" class="taskbar__task" hidden>
        <span aria-hidden="true">♫</span>
        <span id="taskbar-np-label"></span>
      </button>
    </div>
    <script>
      const ITEM_ID = ${item.id};

      // Init player if not already loaded (direct page load vs SPA navigation)
      if (!window.__player) {
        const windowEl = document.getElementById('now-playing-player');
        const titleEl = document.getElementById('player-title-text');
        const bodyEl = document.getElementById('player-body');
        const npBtnEl = document.getElementById('taskbar-np-btn');
        const npLabelEl = document.getElementById('taskbar-np-label');

        if (windowEl && titleEl && bodyEl && npBtnEl && npLabelEl) {
          function load(src, title, artist, playerType) {
            playerType = playerType || 'audio';
            const label = artist ? (artist + ' — ' + title) : title;
            bodyEl.innerHTML = '';
            const iframe = document.createElement('iframe');
            iframe.src = src;
            iframe.title = playerType === 'video' ? 'YouTube player' : 'Bandcamp player';
            iframe.setAttribute('seamless', '');
            iframe.setAttribute('allow', 'autoplay; encrypted-media');
            windowEl.classList.remove('player-window--video', 'player-window--apple-music');
            if (playerType === 'video') {
              iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture');
              iframe.allowFullscreen = true;
              windowEl.classList.add('player-window--video');
            } else if (src.includes('embed.music.apple.com')) {
              windowEl.classList.add('player-window--apple-music');
            }
            bodyEl.appendChild(iframe);
            titleEl.textContent = label;
            npLabelEl.textContent = label;
            npBtnEl.hidden = false;
            delete npBtnEl.dataset.minimized;
            windowEl.hidden = false;
            windowEl.removeAttribute('aria-hidden');
          }
          function stop() {
            bodyEl.innerHTML = '';
            windowEl.classList.remove('player-window--video', 'player-window--apple-music');
            npBtnEl.hidden = true;
            windowEl.hidden = true;
            windowEl.setAttribute('aria-hidden', 'true');
          }
          document.getElementById('player-close')?.addEventListener('click', stop);
          document.getElementById('player-minimize')?.addEventListener('click', () => {
            windowEl.hidden = true;
            npBtnEl.dataset.minimized = 'true';
          });
          npBtnEl.addEventListener('click', () => {
            if (windowEl.hidden) {
              windowEl.hidden = false;
              windowEl.removeAttribute('aria-hidden');
              delete npBtnEl.dataset.minimized;
            } else {
              windowEl.hidden = true;
              npBtnEl.dataset.minimized = 'true';
            }
          });

          // Dragging
          const titlebar = document.getElementById('player-titlebar');
          let startX = 0, startY = 0, startLeft = 0, startTop = 0, dragging = false;
          titlebar?.addEventListener('mousedown', (e) => {
            if (e.target.closest('button')) return;
            dragging = true;
            startX = e.clientX; startY = e.clientY;
            const rect = windowEl.getBoundingClientRect();
            startLeft = rect.left; startTop = rect.top;
            e.preventDefault();
            document.addEventListener('mouseup', () => { dragging = false; }, { once: true });
          });
          document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            windowEl.style.left = (startLeft + (e.clientX - startX)) + 'px';
            windowEl.style.top = (startTop + (e.clientY - startY)) + 'px';
            windowEl.style.bottom = 'auto';
            windowEl.style.right = 'auto';
          });

          window.__player = { load, stop };
        }
      }

      document.querySelectorAll('.release-page__listen-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const src = btn.dataset.src;
          if (src) {
            window.__player?.load(
              src,
              btn.dataset.title ?? '',
              btn.dataset.artist ?? '',
              btn.dataset.playerType ?? 'audio',
            );
          }
        });
      });

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
          artworkUrl: document.getElementById('edit-artwork-url').value.trim() || null,
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
      const ITEM_STACKS = ${JSON.stringify(item.stacks)};
      const assignedIds = new Set(ITEM_STACKS.map(s => s.id));
      let allStacks = ITEM_STACKS;

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
        const query = document.getElementById('new-stack-input').value.trim().toLowerCase();
        const visible = query ? allStacks.filter(s => s.name.toLowerCase().includes(query)) : allStacks;
        el.innerHTML = visible.map(s =>
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

      function sortStacks(stacks) {
        return stacks.sort((a, b) => a.name.localeCompare(b.name));
      }

      async function loadStacks() {
        const res = await fetch('/api/stacks');
        if (res.ok) { allStacks = sortStacks(await res.json()); renderStackChips(); renderStackPicker(); }
      }

      document.getElementById('new-stack-input').addEventListener('input', renderStackPicker);

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
          sortStacks(allStacks);
          await toggleStack(stack.id, true);
        }
      });

      // ── Artwork upload ───────────────────────────────────────────────────
      const artworkUploadBtn = document.getElementById('artwork-upload-btn');
      const artworkFileInput = document.getElementById('artwork-file-input');
      const artworkUrlInput = document.getElementById('edit-artwork-url');

      if (artworkUploadBtn && artworkFileInput && artworkUrlInput) {
        artworkUploadBtn.addEventListener('click', () => artworkFileInput.click());

        artworkFileInput.addEventListener('change', async () => {
          const file = artworkFileInput.files?.[0];
          if (!file) return;

          artworkUploadBtn.disabled = true;
          artworkUploadBtn.textContent = 'Uploading…';

          const previousUrl = artworkUrlInput.value;

          try {
            const dataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = reject;
              reader.readAsDataURL(file);
            });
            const base64 = dataUrl.split(',')[1];
            const res = await fetch('/api/release/image', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ imageBase64: base64 }),
            });
            if (!res.ok) throw new Error('Upload failed: ' + res.status);
            const { artworkUrl } = await res.json();
            artworkUrlInput.value = artworkUrl;
          } catch (err) {
            artworkUrlInput.value = previousUrl;
            alert('Failed to upload image.');
            console.error(err);
          } finally {
            artworkUploadBtn.disabled = false;
            artworkUploadBtn.textContent = 'Replace image';
            artworkFileInput.value = '';
          }
        });
      }

      renderStackChips();
      loadStacks();

      // ── Links ────────────────────────────────────────────────────────────
      let itemLinks = ${JSON.stringify(item.links)};

      function renderLinkList() {
        const el = document.getElementById('link-list');
        if (!el) return;
        el.innerHTML = itemLinks.map(link =>
          '<div class="release-page__link-row">' +
          '<span class="release-page__link-source">' + htmlEsc(link.display_name || link.source_name || 'Link') + '</span>' +
          '<a class="release-page__link-url" href="' + htmlEsc(link.url) + '" target="_blank" rel="noopener noreferrer">' + htmlEsc(link.url) + '</a>' +
          '<button type="button" class="btn release-page__link-remove" data-lid="' + link.id + '" title="Remove">×</button>' +
          '</div>'
        ).join('');
        el.querySelectorAll('.release-page__link-remove').forEach(btn => {
          btn.addEventListener('click', () => removeLink(parseInt(btn.dataset.lid)));
        });
      }

      async function removeLink(linkId) {
        const res = await fetch('/api/music-items/' + ITEM_ID + '/links/' + linkId, { method: 'DELETE' });
        if (res.ok) {
          itemLinks = itemLinks.filter(l => l.id !== linkId);
          renderLinkList();
        }
      }

      // ── Source combobox ──────────────────────────────────────────────────
      let allSources = [];
      const sourceInput = document.getElementById('link-source-input');
      const sourceDropdown = document.getElementById('source-dropdown');

      function renderSourceDropdown(query) {
        const q = query.toLowerCase();
        const matches = q
          ? allSources.filter(s => s.displayName.toLowerCase().includes(q))
          : allSources;
        if (!matches.length) { sourceDropdown.hidden = true; return; }
        sourceDropdown.innerHTML = matches.map(s =>
          '<div class="release-page__source-dropdown-item" data-value="' + htmlEsc(s.displayName) + '">' +
          htmlEsc(s.displayName) + '</div>'
        ).join('');
        sourceDropdown.querySelectorAll('.release-page__source-dropdown-item').forEach(item => {
          item.addEventListener('mousedown', e => {
            e.preventDefault();
            sourceInput.value = item.dataset.value;
            sourceDropdown.hidden = true;
          });
        });
        sourceDropdown.hidden = false;
      }

      sourceInput?.addEventListener('input', () => renderSourceDropdown(sourceInput.value));
      sourceInput?.addEventListener('focus', () => renderSourceDropdown(sourceInput.value));
      sourceInput?.addEventListener('blur', () => { setTimeout(() => { sourceDropdown.hidden = true; }, 150); });

      async function loadSources() {
        const res = await fetch('/api/release/sources');
        if (!res.ok) return;
        allSources = await res.json();
      }

      document.getElementById('add-link-btn')?.addEventListener('click', async () => {
        const urlInput = document.getElementById('link-url-input');
        const sourceName = sourceInput.value.trim();
        const url = urlInput.value.trim();
        if (!sourceName || !url) return;
        const res = await fetch('/api/music-items/' + ITEM_ID + '/links', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceName, url }),
        });
        if (res.ok) {
          const link = await res.json();
          itemLinks.push(link);
          renderLinkList();
          sourceInput.value = '';
          urlInput.value = '';
        } else {
          const err = await res.json().catch(() => ({}));
          alert(err.error || 'Failed to add link');
        }
      });

      renderLinkList();
      loadSources();

      // ── Apple Music secondary link lookup ────────────────────────────────
      const PLAYABLE_SOURCES = new Set(['bandcamp','spotify','soundcloud','youtube','apple_music','tidal','deezer','mixcloud']);
      const primarySource = ${JSON.stringify(item.primary_source)};
      const hasAppleMusicSecondary = ${JSON.stringify(item.links.some((l) => l.source_name === "apple_music" && !l.is_primary))};
      if (!hasAppleMusicSecondary && (!primarySource || !PLAYABLE_SOURCES.has(primarySource))) {
        fetch('/api/release/apple-music-lookup/' + ITEM_ID, { method: 'POST' })
          .then(r => r.ok ? r.json() : null)
          .then(data => {
            if (!data || !data.url) return;
            const container = document.getElementById('secondary-links');
            if (!container) return;
            const a = document.createElement('a');
            a.className = 'release-page__source-link';
            a.href = data.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = 'Apple Music';
            container.appendChild(a);
          })
          .catch(() => {});
      }

      // ── Star Rating ─────────────────────────────────────────────────────────
      const ratingEl = document.querySelector('.release-page [data-rating-stars]');
      const MIN_RATING = 0.5;
      const MAX_RATING = 5;
      const HALF_STEP = 0.5;

      function normalizeRating(value) {
        if (value === null || Number.isNaN(value) || !Number.isFinite(value)) return null;
        const rounded = Math.round(value / HALF_STEP) * HALF_STEP;
        if (rounded < MIN_RATING || rounded > MAX_RATING) return null;
        return rounded;
      }

      function getFillState(rating, starValue) {
        if (rating === null) return 'empty';
        if (rating >= starValue) return 'full';
        if (Math.abs(rating - (starValue - HALF_STEP)) < 0.001) return 'half';
        return 'empty';
      }

      function setRatingButtonsDisabled(element, disabled) {
        element.querySelectorAll('[data-rating-star]').forEach((candidate) => {
          if (candidate instanceof HTMLButtonElement) {
            candidate.disabled = disabled;
          }
        });
      }

      function applyRatingVisualState(element) {
        const preview = normalizeRating(
          element.dataset.previewValue ? Number(element.dataset.previewValue) : null,
        );
        const selected = normalizeRating(
          element.dataset.ratingValue ? Number(element.dataset.ratingValue) : null,
        );
        const effective = preview ?? selected;

        element.querySelectorAll('[data-rating-star]').forEach((candidate) => {
          if (!(candidate instanceof HTMLButtonElement)) return;
          const starValue = normalizeRating(Number(candidate.dataset.ratingStar));
          const fill = starValue === null ? 'empty' : getFillState(effective, starValue);
          const selectedState = starValue === null ? 'empty' : getFillState(selected, starValue);
          candidate.classList.toggle('is-active-full', fill === 'full');
          candidate.classList.toggle('is-active-half', fill === 'half');
          candidate.setAttribute('aria-pressed', selectedState === 'empty' ? 'false' : 'true');
        });
      }

      function resolveValueFromPointer(button, event) {
        const fullValue = normalizeRating(Number(button.dataset.ratingStar));
        if (fullValue === null) return null;
        if (event.detail === 0) return fullValue;

        const rect = button.getBoundingClientRect();
        if (rect.width <= 0) return fullValue;

        const clickX = event.clientX - rect.left;
        const isLeftHalf = clickX < rect.width / 2;
        return normalizeRating(isLeftHalf ? fullValue - HALF_STEP : fullValue);
      }

      if (ratingEl) {
        ratingEl.addEventListener('pointermove', (event) => {
          if (ratingEl.classList.contains('is-pending')) return;
          const target = event.target;
          if (!(target instanceof HTMLElement)) return;
          const button = target.closest('[data-rating-star]');
          if (!(button instanceof HTMLButtonElement)) return;
          const previewValue = resolveValueFromPointer(button, event);
          if (previewValue === null) return;
          ratingEl.dataset.previewValue = String(previewValue);
          applyRatingVisualState(ratingEl);
        });

        ratingEl.addEventListener('pointerout', (event) => {
          if (ratingEl.classList.contains('is-pending')) return;
          const target = event.target;
          if (!(target instanceof Node) || !ratingEl.contains(target)) return;
          const related = event.relatedTarget;
          if (related instanceof Node && ratingEl.contains(related)) return;
          delete ratingEl.dataset.previewValue;
          applyRatingVisualState(ratingEl);
        });

        ratingEl.addEventListener('click', async (event) => {
          if (ratingEl.classList.contains('is-pending')) return;
          const target = event.target;
          if (!(target instanceof HTMLElement)) return;
          const button = target.closest('[data-rating-star]');
          if (!(button instanceof HTMLButtonElement)) return;

          const selectedValue = resolveValueFromPointer(button, event);
          if (selectedValue === null) return;

          const current = normalizeRating(
            ratingEl.dataset.ratingValue ? Number(ratingEl.dataset.ratingValue) : null,
          );
          const next = current === selectedValue ? null : selectedValue;

          delete ratingEl.dataset.previewValue;
          ratingEl.dataset.ratingValue = next === null ? '' : String(next);
          applyRatingVisualState(ratingEl);
          ratingEl.classList.add('is-pending');
          setRatingButtonsDisabled(ratingEl, true);

          try {
            const res = await fetch('/api/music-items/' + ITEM_ID, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ rating: next }),
            });
            if (!res.ok) {
              ratingEl.dataset.ratingValue = current === null ? '' : String(current);
              applyRatingVisualState(ratingEl);
              alert('Failed to update rating.');
            }
          } catch (error) {
            ratingEl.dataset.ratingValue = current === null ? '' : String(current);
            applyRatingVisualState(ratingEl);
            alert('Failed to update rating.');
            console.error(error);
          } finally {
            ratingEl.classList.remove('is-pending');
            setRatingButtonsDisabled(ratingEl, false);
          }
        });
      }

      document.getElementById('set-reminder-btn').addEventListener('click', async () => {
        const input = document.getElementById('remind-at');
        const btn = document.getElementById('set-reminder-btn');
        const remindAt = input.value;
        if (!remindAt) return;
        const res = await fetch('/api/music-items/' + ITEM_ID + '/reminder', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ remindAt }),
        });
        if (!res.ok) { alert('Failed to set reminder'); return; }
        input.dataset.saved = remindAt;
        const originalText = btn.textContent;
        btn.textContent = 'Saved!';
        btn.classList.add('btn--saved');
        setTimeout(() => {
          btn.textContent = originalText;
          btn.classList.remove('btn--saved');
        }, 2000);
      });

      document.getElementById('clear-reminder-btn')?.addEventListener('click', async () => {
        const res = await fetch('/api/music-items/' + ITEM_ID + '/reminder', { method: 'DELETE' });
        if (!res.ok) { alert('Failed to clear reminder'); return; }
        document.getElementById('remind-at').value = '';
        document.getElementById('clear-reminder-btn').remove();
      });
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

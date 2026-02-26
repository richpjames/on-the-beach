import type { MusicItemFull, StackWithCount } from "../../types";
import type { FilterSelection } from "../domain/music-list";
import { getEmptyStateMessage } from "../domain/music-list";
import { STATUS_LABELS } from "../domain/status";

export function renderMusicList(items: MusicItemFull[], currentFilter: FilterSelection): string {
  if (items.length === 0) {
    const message = getEmptyStateMessage(currentFilter);
    return `
      <div class="empty-state">
        <p>${message}</p>
      </div>
    `;
  }

  return items.map((item) => renderMusicCard(item)).join("");
}

export function renderMusicCard(item: MusicItemFull): string {
  const statusOptions = Object.entries(STATUS_LABELS)
    .map(
      ([value, label]) =>
        `<option value="${value}" ${item.listen_status === value ? "selected" : ""}>${label}</option>`,
    )
    .join("");

  return `
    <article class="music-card" data-item-id="${item.id}">
      ${
        item.artwork_url
          ? `<img class="music-card__artwork" src="${escapeHtml(item.artwork_url)}" alt="Artwork for ${escapeHtml(item.title)}">`
          : ""
      }
      <div class="music-card__content">
        <div class="music-card__title">${escapeHtml(item.title)}</div>
        ${item.artist_name ? `<div class="music-card__artist">${escapeHtml(item.artist_name)}</div>` : ""}
        ${
          item.stacks.length > 0
            ? `<div class="music-card__stacks">${item.stacks
                .map(
                  (stack) =>
                    `<span class="music-card__stack-chip">${escapeHtml(stack.name)}</span>`,
                )
                .join("")}</div>`
            : ""
        }
        <div class="music-card__meta">
          <select class="status-select">${statusOptions}</select>
          ${["listened", "to-revisit"].includes(item.listen_status) ? renderStarRating(item.id, item.rating) : ""}
          ${
            item.primary_source
              ? item.primary_url
                ? `<a href="${escapeHtml(item.primary_url)}" target="_blank" rel="noopener noreferrer" class="badge badge--source">${escapeHtml(item.primary_source)}</a>`
                : `<span class="badge badge--source">${escapeHtml(item.primary_source)}</span>`
              : ""
          }
        </div>
      </div>
      <div class="music-card__actions">
        ${
          item.primary_url
            ? `
          <a href="${escapeHtml(item.primary_url)}" target="_blank" rel="noopener noreferrer" class="btn btn--ghost" title="Open link">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
              <polyline points="15 3 21 3 21 9"></polyline>
              <line x1="10" y1="14" x2="21" y2="3"></line>
            </svg>
          </a>
        `
            : ""
        }
        <button class="btn btn--ghost" data-action="stack" title="Manage stacks">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </button>
        <button type="button" class="btn btn--ghost btn--danger" data-action="delete" title="Delete">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    </article>
  `;
}

export function renderStackManageList(stacks: StackWithCount[]): string {
  return stacks
    .map(
      (stack) => `
      <div class="stack-manage__item" data-manage-stack-id="${stack.id}">
        <span class="stack-manage__name">${escapeHtml(stack.name)}</span>
        <span class="stack-manage__count">${stack.item_count} items</span>
        <button class="stack-manage__rename-btn">rename</button>
        <button class="stack-manage__delete-btn">delete</button>
      </div>
    `,
    )
    .join("");
}

export function renderStackRenameEditor(currentName: string): string {
  return `
    <input type="text" class="stack-manage__rename-input input" value="${escapeHtml(currentName)}">
    <button class="stack-manage__rename-confirm">save</button>
  `;
}

export function renderAddFormStackChips(
  selectedStackIds: number[],
  stacks: StackWithCount[],
): string {
  return selectedStackIds
    .map((stackId) => {
      const stack = stacks.find((candidate) => candidate.id === stackId);
      if (!stack) {
        return "";
      }

      return `<span class="stack-chip">
        ${escapeHtml(stack.name)}
        <button type="button" class="stack-chip__remove" data-remove-stack="${stackId}">&times;</button>
      </span>`;
    })
    .join("");
}

export function renderStackDropdownContent(
  stacks: StackWithCount[],
  selectedStackIds: Set<number>,
): string {
  return `
    ${stacks
      .map(
        (stack) => `
      <label class="stack-dropdown__item">
        <input type="checkbox" class="stack-dropdown__checkbox"
               data-stack-id="${stack.id}" ${selectedStackIds.has(stack.id) ? "checked" : ""}>
        ${escapeHtml(stack.name)}
      </label>
    `,
      )
      .join("")}
    <div class="stack-dropdown__new">
      <input type="text" class="stack-dropdown__new-input input"
             placeholder="New stack...">
    </div>
  `;
}

function renderStarRating(itemId: number, rating: number | null): string {
  const stars = [5, 4, 3, 2, 1]
    .map(
      (value) => `
        <input type="radio" id="star-${itemId}-${value}" name="rating-${itemId}" value="${value}" ${rating === value ? "checked" : ""}>
        <label for="star-${itemId}-${value}" title="${value} star${value > 1 ? "s" : ""}">&#9733;</label>`,
    )
    .join("");

  return `
    <fieldset class="star-rating">
      <legend class="visually-hidden">Rating</legend>
      ${stars}
    </fieldset>`;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

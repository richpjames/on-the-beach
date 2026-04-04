import Case from "case";
import type { LinkReleaseCandidate, MusicItemFull, StackWithCount } from "../../types";
import { renderStarRatingControl } from "../components/star-rating";
import type { FilterSelection } from "../domain/music-list";
import { getEmptyStateMessage } from "../domain/music-list";
import { STATUS_LABELS } from "../domain/status";

export function renderMusicList(
  items: MusicItemFull[],
  currentFilter: FilterSelection,
  searchQuery = "",
): string {
  if (items.length === 0) {
    const message = escapeHtml(getEmptyStateMessage(currentFilter, searchQuery));
    return `
      <div class="empty-state">
        <p>${message}</p>
      </div>
    `;
  }

  return items.map((item) => renderMusicCard(item)).join("");
}

export function renderMusicCard(item: MusicItemFull): string {
  const hasArtwork = Boolean(item.artwork_url);
  const escapedTitle = escapeHtml(item.title);
  const releaseHref = `/r/${item.id}`;
  const statusOptions = Object.entries(STATUS_LABELS)
    .map(
      ([value, label]) =>
        `<option value="${value}" ${item.listen_status === value ? "selected" : ""}>${label}</option>`,
    )
    .join("");

  return `
    <article class="music-card${hasArtwork ? "" : " music-card--no-artwork"}" data-item-id="${item.id}">
      <a href="${releaseHref}">
        ${
          item.artwork_url
            ? `<img class="music-card__artwork music-card__artwork--link" src="${escapeHtml(item.artwork_url)}" alt="Artwork for ${escapedTitle}">`
            : `<img class="music-card__artwork music-card__artwork--placeholder" src="/favicon-32x32.png" alt="No artwork available">`
        }
      </a>
      <div class="music-card__content">
        <a href="${releaseHref}" class="music-card__link">
          <div class="music-card__title">${escapedTitle}</div>
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
        </a>
        <div class="music-card__meta">
          <select class="status-select">${statusOptions}</select>
          ${renderStarRating(item.id, item.rating)}
          ${
            item.primary_source
              ? item.primary_url
                ? `<a href="${escapeHtml(item.primary_url)}" target="_blank" rel="noopener noreferrer" class="badge badge--source">${escapeHtml(Case.title(item.primary_source))}</a>`
                : `<span class="badge badge--source">${escapeHtml(Case.title(item.primary_source))}</span>`
              : ""
          }
        </div>
      </div>
      <div class="music-card__actions">
        <button
          type="button"
          class="btn btn--ghost music-card__reorder-handle"
          title="Reorder ${escapedTitle}"
          aria-label="Reorder ${escapedTitle}"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
            <rect x="2" y="2" width="2" height="2"></rect>
            <rect x="2" y="6" width="2" height="2"></rect>
            <rect x="2" y="10" width="2" height="2"></rect>
            <rect x="8" y="2" width="2" height="2"></rect>
            <rect x="8" y="6" width="2" height="2"></rect>
            <rect x="8" y="10" width="2" height="2"></rect>
          </svg>
        </button>
        ${
          item.primary_url
            ? `
          <a href="${escapeHtml(item.primary_url)}" target="_blank" rel="noopener noreferrer" class="btn btn--ghost music-card__action-btn" title="Open link">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
              <polyline points="15 3 21 3 21 9"></polyline>
              <line x1="10" y1="14" x2="21" y2="3"></line>
            </svg>
          </a>
        `
            : ""
        }
        <button type="button" class="btn btn--ghost music-card__action-btn" data-action="stack" title="Manage stacks">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </button>
        <a href="${releaseHref}" class="btn btn--ghost music-card__action-btn" title="View release page">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
          </svg>
        </a>
        <button type="button" class="btn btn--ghost btn--danger music-card__action-btn" data-action="delete" title="Delete">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
        <button
          type="button"
          class="btn btn--ghost music-card__menu-toggle"
          data-action="toggle-item-menu"
          title="More actions"
          aria-haspopup="true"
          aria-expanded="false"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="12" cy="5" r="1.8"></circle>
            <circle cx="12" cy="12" r="1.8"></circle>
            <circle cx="12" cy="19" r="1.8"></circle>
          </svg>
        </button>
        <div class="music-card__menu-panel" hidden>
          ${
            item.primary_url
              ? `<a href="${escapeHtml(item.primary_url)}" target="_blank" rel="noopener noreferrer" class="music-card__menu-item">Open link</a>`
              : ""
          }
          <button type="button" class="music-card__menu-item" data-action="stack-menu">
            Manage stacks
          </button>
          <a href="${releaseHref}" class="music-card__menu-item">View release page</a>
          <button
            type="button"
            class="music-card__menu-item music-card__menu-item--danger"
            data-action="delete-menu"
          >
            Delete
          </button>
        </div>
      </div>
    </article>
  `;
}

export function renderStackManageList(stacks: StackWithCount[]): string {
  if (stacks.length === 0) {
    return '<p class="stack-manage__empty">No matching lists.</p>';
  }

  return stacks
    .map(
      (stack) => `
      <div class="stack-manage__item" data-manage-stack-id="${stack.id}">
        <span class="stack-manage__name">${escapeHtml(stack.name)}</span>
        <span class="stack-manage__count">${stack.item_count} items</span>
        ${
          stack.parent_stack_ids.length === 0
            ? ""
            : `<span class="stack-manage__parent-chip" title="Has parent list">nested</span>`
        }
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
    <div class="stack-dropdown__list">
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
    </div>
    <div class="stack-dropdown__new">
      <input type="text" class="stack-dropdown__new-input input"
             placeholder="New stack...">
    </div>
  `;
}

export function renderAmbiguousLinkCandidates(
  candidates: LinkReleaseCandidate[],
  selectedCandidateIds: string[],
): string {
  return candidates
    .map((candidate) => {
      const isSelected = selectedCandidateIds.includes(candidate.candidateId);
      return `
        <button
          type="button"
          class="link-picker__candidate${isSelected ? " is-selected" : ""}"
          data-candidate-id="${escapeHtml(candidate.candidateId)}"
          aria-pressed="${isSelected ? "true" : "false"}"
        >
          <span class="link-picker__candidate-main">
            <span class="link-picker__candidate-title">${escapeHtml(candidate.title)}</span>
            ${
              candidate.artist
                ? `<span class="link-picker__candidate-artist">${escapeHtml(candidate.artist)}</span>`
                : ""
            }
          </span>
          <span class="link-picker__candidate-meta">
            ${
              candidate.itemType
                ? `<span class="badge badge--source">${escapeHtml(candidate.itemType)}</span>`
                : ""
            }
            ${candidate.isPrimary ? `<span class="badge badge--source">primary</span>` : ""}
          </span>
          ${
            candidate.evidence
              ? `<span class="link-picker__candidate-evidence">${escapeHtml(candidate.evidence)}</span>`
              : ""
          }
        </button>
      `;
    })
    .join("");
}

export function renderStarRating(itemId: number, rating: number | null, cssClass?: string): string {
  return renderStarRatingControl({
    itemId,
    rating,
    className: cssClass,
  });
}

export function renderFolderRow(child: { id: number; name: string; item_count: number }): string {
  return `
    <article class="folder-row" data-child-stack-id="${child.id}">
      <div class="folder-row__icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
        </svg>
      </div>
      <div class="folder-row__content">
        <span class="folder-row__name">${escapeHtml(child.name)}</span>
        <span class="folder-row__count">(${child.item_count} items)</span>
      </div>
      <div class="folder-row__actions">
        <button type="button" class="btn btn--ghost folder-row__reorder-handle" title="Reorder" aria-label="Reorder ${escapeHtml(child.name)}">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
            <rect x="2" y="2" width="2" height="2"></rect>
            <rect x="2" y="6" width="2" height="2"></rect>
            <rect x="2" y="10" width="2" height="2"></rect>
            <rect x="8" y="2" width="2" height="2"></rect>
            <rect x="8" y="6" width="2" height="2"></rect>
            <rect x="8" y="10" width="2" height="2"></rect>
          </svg>
        </button>
        <button type="button" class="btn btn--ghost btn--danger folder-row__remove-btn" data-remove-child-stack="${child.id}" title="Remove from this list">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    </article>
  `;
}

export function renderBreadcrumbs(trail: Array<{ id: number; name: string }>): string {
  if (trail.length === 0) return "";

  const crumbs = trail
    .map((crumb, index) =>
      index < trail.length - 1
        ? `<button type="button" class="breadcrumb__link" data-breadcrumb-stack="${crumb.id}">${escapeHtml(crumb.name)}</button>`
        : `<span class="breadcrumb__current">${escapeHtml(crumb.name)}</span>`,
    )
    .join('<span class="breadcrumb__sep"> &gt; </span>');

  return `<nav class="breadcrumb" aria-label="List navigation">${crumbs}</nav>`;
}

export function renderChildStackPicker(
  candidates: Array<{ id: number; name: string; item_count: number }>,
): string {
  if (candidates.length === 0) {
    return '<div class="child-stack-picker__empty">No lists available to add.</div>';
  }

  return candidates
    .map(
      (stack) => `
      <button type="button" class="child-stack-picker__item" data-picker-stack-id="${stack.id}">
        <span class="child-stack-picker__name">${escapeHtml(stack.name)}</span>
        <span class="child-stack-picker__count">${stack.item_count} items</span>
      </button>
    `,
    )
    .join("");
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

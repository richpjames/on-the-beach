import { isValidStarCount } from "../../../domain/rating";
import {
  DEFAULT_STAR_COUNT,
  normalizeStarRating,
  starFill,
  starGlyphValues,
} from "./star-rating-model";

export interface StarRatingRenderOptions {
  itemId: number;
  rating: number | null;
  /** How many stars the scale has — defaults to 5. */
  starCount?: number;
  className?: string;
}

export interface StarRatingInteraction {
  element: HTMLElement;
  itemId: number;
  currentRating: number | null;
  nextRating: number | null;
}

export interface StarRatingHoverInteraction {
  element: HTMLElement;
  hoverRating: number;
}

export function renderStarRatingControl({
  itemId,
  rating,
  starCount = DEFAULT_STAR_COUNT,
  className,
}: StarRatingRenderOptions): string {
  const normalized = normalizeStarRating(rating, starCount);
  const stars = starGlyphValues(starCount)
    .map((value) => {
      const fill = starFill(normalized, value);
      const starClass =
        fill === "full" ? " is-active-full" : fill === "half" ? " is-active-half" : "";
      return `
      <button
        type="button"
        class="rating-stars__star${starClass}"
        data-rating-star="${value}"
        aria-label="${value} star${value === 1 ? "" : "s"}"
        aria-pressed="${fill === "empty" ? "false" : "true"}"
      >
        <span aria-hidden="true">★</span>
      </button>`;
    })
    .join("");

  return `
    <div
      class="rating-stars${className ? ` ${className}` : ""}"
      data-rating-stars
      data-item-id="${itemId}"
      data-star-count="${starCount}"
      data-rating-value="${normalized ?? ""}"
      role="group"
      aria-label="Rating"
    >
      ${stars}
    </div>`;
}

/**
 * The scale a rendered control paints: the count it declares, else its
 * highest glyph value. The declared count is authoritative (StarRating.svelte
 * stamps the same attribute); the glyph scan only covers markup from before
 * the attribute existed, and seeds at zero — not the default 5 — so a sub-5
 * or fractional scale resolves to its own size rather than 5.
 */
function scaleOf(element: HTMLElement): number {
  const declared = Number(element.dataset.starCount);
  if (isValidStarCount(declared)) {
    return declared;
  }

  let max = 0;
  element.querySelectorAll("[data-rating-star]").forEach((candidate) => {
    const value = Number((candidate as HTMLElement).dataset.ratingStar);
    if (Number.isFinite(value) && value > max) {
      max = value;
    }
  });
  return max > 0 ? max : DEFAULT_STAR_COUNT;
}

export function resolveStarRatingInteraction(event: MouseEvent): StarRatingInteraction | null {
  const target = event.target as HTMLElement | null;
  if (!target) {
    return null;
  }

  const button = target.closest("[data-rating-star]") as HTMLButtonElement | null;
  if (!button) {
    return null;
  }

  const element = button.closest("[data-rating-stars]") as HTMLElement | null;
  if (!element) {
    return null;
  }

  const itemId = Number(element.dataset.itemId);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return null;
  }

  const selectedValue = resolveSelectedRatingValue(button, event);
  if (selectedValue === null) {
    return null;
  }

  const currentRating = normalizeStarRating(
    element.dataset.ratingValue ? Number(element.dataset.ratingValue) : null,
    scaleOf(element),
  );
  const nextRating = currentRating === selectedValue ? null : selectedValue;

  return {
    element,
    itemId,
    currentRating,
    nextRating,
  };
}

export function resolveStarRatingHover(event: MouseEvent): StarRatingHoverInteraction | null {
  const target = event.target as HTMLElement | null;
  if (!target) {
    return null;
  }

  const button = target.closest("[data-rating-star]") as HTMLButtonElement | null;
  if (!button) {
    return null;
  }

  const element = button.closest("[data-rating-stars]") as HTMLElement | null;
  if (!element) {
    return null;
  }

  const hoverRating = resolveSelectedRatingValue(button, event);
  if (hoverRating === null) {
    return null;
  }

  return { element, hoverRating };
}

export function setStarRatingValue(element: HTMLElement, rating: number | null): void {
  const normalized = normalizeStarRating(rating, scaleOf(element));
  element.dataset.ratingValue = normalized === null ? "" : String(normalized);
  applyStarRatingVisualState(element);
}

export function setStarRatingPreview(element: HTMLElement, rating: number | null): void {
  const normalized = normalizeStarRating(rating, scaleOf(element));
  element.dataset.previewValue = normalized === null ? "" : String(normalized);
  applyStarRatingVisualState(element);
}

export function clearStarRatingPreview(element: HTMLElement): void {
  delete element.dataset.previewValue;
  applyStarRatingVisualState(element);
}

function applyStarRatingVisualState(element: HTMLElement): void {
  const starCount = scaleOf(element);
  const preview = normalizeStarRating(
    element.dataset.previewValue ? Number(element.dataset.previewValue) : null,
    starCount,
  );
  const selected = normalizeStarRating(
    element.dataset.ratingValue ? Number(element.dataset.ratingValue) : null,
    starCount,
  );
  const effective = preview ?? selected;

  const buttons = element.querySelectorAll("[data-rating-star]");
  buttons.forEach((candidate) => {
    if (!(candidate instanceof HTMLButtonElement)) {
      return;
    }

    const value = normalizeStarRating(Number(candidate.dataset.ratingStar), starCount);
    const fill = value === null ? "empty" : starFill(effective, value);
    const isSelected = value !== null && starFill(selected, value) !== "empty";
    candidate.classList.toggle("is-active-full", fill === "full");
    candidate.classList.toggle("is-active-half", fill === "half");
    candidate.setAttribute("aria-pressed", isSelected ? "true" : "false");
  });
}

export function setStarRatingPending(element: HTMLElement, pending: boolean): void {
  element.classList.toggle("is-pending", pending);
  const buttons = element.querySelectorAll("[data-rating-star]");
  buttons.forEach((candidate) => {
    if (!(candidate instanceof HTMLButtonElement)) {
      return;
    }

    candidate.disabled = pending;
  });
}

function resolveSelectedRatingValue(button: HTMLButtonElement, event: MouseEvent): number | null {
  const starCount = scaleOf(
    (button.closest("[data-rating-stars]") as HTMLElement | null) ?? button,
  );
  const fullValue = normalizeStarRating(Number(button.dataset.ratingStar), starCount);
  if (fullValue === null) {
    return null;
  }

  // Keyboard-triggered click events should select the whole star.
  if (event.detail === 0) {
    return fullValue;
  }

  const rect = button.getBoundingClientRect();
  if (rect.width <= 0) {
    return fullValue;
  }

  const clickX = event.clientX - rect.left;
  const isLeftHalf = clickX < rect.width / 2;
  if (!isLeftHalf) {
    return fullValue;
  }

  return normalizeStarRating(fullValue - 0.5, starCount);
}

export { normalizeStarRating };

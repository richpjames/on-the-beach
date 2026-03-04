const MIN_RATING = 0.5;
const MAX_RATING = 5;
const HALF_STEP = 0.5;

export interface StarRatingRenderOptions {
  itemId: number;
  rating: number | null;
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

type StarFillState = "empty" | "half" | "full";

export function renderStarRatingControl({
  itemId,
  rating,
  className,
}: StarRatingRenderOptions): string {
  const normalized = normalizeStarRating(rating);
  const stars = Array.from({ length: MAX_RATING }, (_, index) => {
    const value = MAX_RATING - index;
    const fill = getStarFillState(normalized, value);
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
  }).join("");

  return `
    <div
      class="rating-stars${className ? ` ${className}` : ""}"
      data-rating-stars
      data-item-id="${itemId}"
      data-rating-value="${normalized ?? ""}"
      role="group"
      aria-label="Rating"
    >
      ${stars}
    </div>`;
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
  const normalized = normalizeStarRating(rating);
  element.dataset.ratingValue = normalized === null ? "" : String(normalized);
  applyStarRatingVisualState(element);
}

export function setStarRatingPreview(element: HTMLElement, rating: number | null): void {
  const normalized = normalizeStarRating(rating);
  element.dataset.previewValue = normalized === null ? "" : String(normalized);
  applyStarRatingVisualState(element);
}

export function clearStarRatingPreview(element: HTMLElement): void {
  delete element.dataset.previewValue;
  applyStarRatingVisualState(element);
}

function applyStarRatingVisualState(element: HTMLElement): void {
  const preview = normalizeStarRating(
    element.dataset.previewValue ? Number(element.dataset.previewValue) : null,
  );
  const selected = normalizeStarRating(
    element.dataset.ratingValue ? Number(element.dataset.ratingValue) : null,
  );
  const effective = preview ?? selected;

  const buttons = element.querySelectorAll("[data-rating-star]");
  buttons.forEach((candidate) => {
    if (!(candidate instanceof HTMLButtonElement)) {
      return;
    }

    const value = normalizeStarRating(Number(candidate.dataset.ratingStar));
    const fill = value === null ? "empty" : getStarFillState(effective, value);
    const isSelected = value !== null && getStarFillState(selected, value) !== "empty";
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

export function normalizeStarRating(rating: number | null): number | null {
  if (rating === null || !Number.isFinite(rating)) {
    return null;
  }

  const rounded = Math.round(rating / HALF_STEP) * HALF_STEP;
  if (rounded < MIN_RATING || rounded > MAX_RATING) {
    return null;
  }

  return rounded;
}

function getStarFillState(rating: number | null, starValue: number): StarFillState {
  if (rating === null) {
    return "empty";
  }

  if (rating >= starValue) {
    return "full";
  }

  if (Math.abs(rating - (starValue - HALF_STEP)) < 0.001) {
    return "half";
  }

  return "empty";
}

function resolveSelectedRatingValue(button: HTMLButtonElement, event: MouseEvent): number | null {
  const fullValue = normalizeStarRating(Number(button.dataset.ratingStar));
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

  return normalizeStarRating(fullValue - HALF_STEP);
}

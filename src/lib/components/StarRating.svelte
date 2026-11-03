<script lang="ts">
  import {
    DEFAULT_STAR_COUNT,
    normalizeStarRating,
    ratingForPointer,
    starFill,
    starGlyphValues,
  } from "../../ui/components/star-rating-model";
  import { starRatingToStored, storedToStarRating } from "../../../domain/rating";

  let {
    itemId,
    rating,
    starCount = DEFAULT_STAR_COUNT,
    className = "",
    label = "Rating",
    onRate,
  }: {
    /**
     * The item being rated, stamped as `data-item-id` for the list code that
     * scrolls to a card. Omitted when the stars aren't attached to an item.
     */
    itemId?: number;
    /** The stored rating, out of 100 — see domain/rating.ts. */
    rating: number | null;
    /** How many stars the scale has; the settings page decides. */
    starCount?: number;
    className?: string;
    /** Group label for screen readers; override when it isn't an item rating. */
    label?: string;
    /**
     * Persist the new rating — already converted to the stored out-of-100
     * value, so callers pass it straight through. Throw to roll back the
     * optimistic update.
     */
    onRate: (next: number | null) => Promise<void>;
  } = $props();

  // The committed rating as a star value, mirrored from props (optimistically
  // updated on click). The stored value keeps the precision; this is what the
  // glyphs can paint.
  let selected = $state<number | null>(null);
  $effect.pre(() => {
    selected = storedToStarRating(rating, starCount);
  });

  // The live hover value; null when the pointer is away. Never persisted.
  let preview = $state<number | null>(null);
  let pending = $state(false);

  // What the stars actually paint: hover wins over the committed selection.
  const effective = $derived(preview ?? selected);

  // Descending so DOM order matches `row-reverse` painting left-to-right.
  const stars = $derived(starGlyphValues(starCount));

  // Past ten stars the default 24px hit areas can't fit a row; shrink the
  // glyphs by band so a 100-star scale still fits the card. The bands trade
  // tap target for density — big scales are precision picks, not nudges.
  const scaleClass = $derived.by(() => {
    if (starCount > 40) return " rating-stars--packed";
    if (starCount > 20) return " rating-stars--tight";
    if (starCount > 10) return " rating-stars--compact";
    return "";
  });

  /** Fraction (0..1) of how far across a star button the pointer sits. */
  function pointerFraction(event: PointerEvent | MouseEvent): number {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (rect.width <= 0) return 1;
    const x = event.clientX - rect.left;
    return Math.min(1, Math.max(0, x / rect.width));
  }

  function onPointerMove(starValue: number, event: PointerEvent): void {
    if (pending) return;
    // A hover is purely positional — always derive the half from where we are.
    preview = ratingForPointer(starValue, pointerFraction(event), starCount);
  }

  function onPointerLeave(): void {
    preview = null;
  }

  async function commit(next: number | null): Promise<void> {
    const previous = selected;
    preview = null;
    selected = next;
    pending = true;
    try {
      await onRate(next === null ? null : starRatingToStored(next, starCount));
    } catch (error) {
      console.error("Failed to update rating:", error);
      selected = previous;
      alert("Failed to update rating. Please try again.");
    } finally {
      pending = false;
    }
  }

  async function onClick(starValue: number, event: MouseEvent): Promise<void> {
    if (pending) return;
    // Keyboard activation (Enter/Space) reports detail 0 and has no position —
    // it means "the whole star". A mouse click uses the pointer geometry.
    const value =
      event.detail === 0
        ? normalizeStarRating(starValue, starCount)
        : ratingForPointer(starValue, pointerFraction(event), starCount);
    if (value === null) return;
    // Clicking the already-selected value clears the rating.
    await commit(selected === value ? null : value);
  }
</script>

<div
  class="rating-stars{scaleClass}{className ? ` ${className}` : ''}"
  class:is-pending={pending}
  data-rating-stars
  data-item-id={itemId}
  data-star-count={starCount}
  data-rating-value={selected ?? ""}
  role="group"
  aria-label="{label} (out of {starCount})"
  onpointerleave={onPointerLeave}
>
  {#each stars as value (value)}
    {@const fill = starFill(effective, value)}
    {@const selectedFill = starFill(selected, value)}
    <button
      type="button"
      class="rating-stars__star"
      class:is-active-full={fill === "full"}
      class:is-active-half={fill === "half"}
      data-rating-star={value}
      aria-label="{value} star{value === 1 ? '' : 's'}"
      aria-pressed={selectedFill === "empty" ? "false" : "true"}
      disabled={pending}
      onpointermove={(e) => onPointerMove(value, e)}
      onclick={(e) => onClick(value, e)}
    >
      <span aria-hidden="true">★</span>
    </button>
  {/each}
</div>

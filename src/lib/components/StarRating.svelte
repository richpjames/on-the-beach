<script lang="ts">
  import {
    MAX_STARS,
    normalizeStarRating,
    ratingForPointer,
    starFill,
  } from "../../ui/components/star-rating-model";

  let {
    itemId,
    rating,
    className = "",
    label = "Rating",
    onRate,
  }: {
    /**
     * The item being rated, stamped as `data-item-id` for the list code that
     * scrolls to a card. Omitted when the stars aren't attached to an item —
     * the settings page uses them to pick a threshold, not to rate anything.
     */
    itemId?: number;
    rating: number | null;
    className?: string;
    /** Group label for screen readers; override when it isn't an item rating. */
    label?: string;
    /** Persist the new rating; throw to roll back the optimistic update. */
    onRate: (next: number | null) => Promise<void>;
  } = $props();

  // The committed rating, mirrored from props (optimistically updated on click).
  let selected = $state<number | null>(null);
  $effect.pre(() => {
    selected = normalizeStarRating(rating);
  });

  // The live hover value; null when the pointer is away. Never persisted.
  let preview = $state<number | null>(null);
  let pending = $state(false);

  // What the stars actually paint: hover wins over the committed selection.
  const effective = $derived(preview ?? selected);

  // Descending so DOM order is 5..1; `row-reverse` paints them left-to-right.
  const stars = Array.from({ length: MAX_STARS }, (_, i) => MAX_STARS - i);

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
    preview = ratingForPointer(starValue, pointerFraction(event));
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
      await onRate(next);
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
      event.detail === 0 ? starValue : ratingForPointer(starValue, pointerFraction(event));
    if (value === null) return;
    // Clicking the already-selected value clears the rating.
    await commit(selected === value ? null : value);
  }
</script>

<div
  class="rating-stars{className ? ` ${className}` : ''}"
  class:is-pending={pending}
  data-rating-stars
  data-item-id={itemId}
  data-rating-value={selected ?? ""}
  role="group"
  aria-label={label}
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

<script lang="ts">
  import { normalizeStarRating } from "../../ui/components/star-rating";

  const MAX_RATING = 5;
  const HALF_STEP = 0.5;

  let {
    itemId,
    rating,
    className = "",
    onRate,
  }: {
    itemId: number;
    rating: number | null;
    className?: string;
    /** Persist the new rating; throw to roll back the optimistic update. */
    onRate: (next: number | null) => Promise<void>;
  } = $props();

  let selected = $state<number | null>(null);
  $effect.pre(() => {
    selected = normalizeStarRating(rating);
  });

  let preview = $state<number | null>(null);
  let pending = $state(false);

  const effective = $derived(preview ?? selected);

  type Fill = "empty" | "half" | "full";

  function fillFor(value: number | null, starValue: number): Fill {
    if (value === null) return "empty";
    if (value >= starValue) return "full";
    if (Math.abs(value - (starValue - HALF_STEP)) < 0.001) return "half";
    return "empty";
  }

  function resolveValueFromPointer(starValue: number, event: MouseEvent): number | null {
    // Keyboard-triggered click events select the whole star.
    if (event.detail === 0) return starValue;

    const button = (event.currentTarget ?? event.target) as HTMLElement;
    const rect = button.getBoundingClientRect();
    if (rect.width <= 0) return starValue;

    const isLeftHalf = event.clientX - rect.left < rect.width / 2;
    return normalizeStarRating(isLeftHalf ? starValue - HALF_STEP : starValue);
  }

  function onPointerMove(starValue: number, event: PointerEvent): void {
    if (pending) return;
    preview = resolveValueFromPointer(starValue, event);
  }

  function onPointerLeave(): void {
    preview = null;
  }

  async function onClick(starValue: number, event: MouseEvent): Promise<void> {
    if (pending) return;
    const value = resolveValueFromPointer(starValue, event);
    if (value === null) return;

    const previous = selected;
    const next = previous === value ? null : value;

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
</script>

<div
  class="rating-stars{className ? ` ${className}` : ''}"
  class:is-pending={pending}
  data-rating-stars
  data-item-id={itemId}
  data-rating-value={selected ?? ""}
  role="group"
  aria-label="Rating"
  onpointerleave={onPointerLeave}
>
  {#each Array.from({ length: MAX_RATING }, (_, index) => MAX_RATING - index) as value (value)}
    {@const fill = fillFor(effective, value)}
    {@const selectedFill = fillFor(selected, value)}
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

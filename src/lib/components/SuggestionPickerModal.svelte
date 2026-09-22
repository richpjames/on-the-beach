<script lang="ts">
  import type { ItemSuggestion } from "../../../domain/types";
  import { api } from "../api";
  import SuggestionArtwork from "./SuggestionArtwork.svelte";

  let {
    suggestions,
    sourceItemId,
    onAccepted,
    onClosed,
  }: {
    suggestions: ItemSuggestion[];
    sourceItemId: number | null;
    onAccepted: () => void;
    onClosed: () => void;
  } = $props();

  const isOpen = $derived(suggestions.length > 0);

  // The suggestions the "Add to list" button will take. Reset whenever the
  // prompt opens with a different set, so stale ids can't carry over. The
  // first stays preselected: accepting straight away still adds the top pick.
  let selectedIds = $state<Set<number>>(new Set());
  const suggestionsKey = $derived(suggestions.map((s) => s.id).join(","));

  $effect.pre(() => {
    void suggestionsKey;
    selectedIds = new Set(suggestions.slice(0, 1).map((s) => s.id));
  });

  function toggle(suggestionId: number): void {
    const next = new Set(selectedIds);
    if (next.has(suggestionId)) {
      next.delete(suggestionId);
    } else {
      next.add(suggestionId);
    }
    selectedIds = next;
  }

  const artistNames = $derived([...new Set(suggestions.map((s) => s.artistName))]);
  const message = $derived.by(() => {
    if (suggestions.length === 0) return "";
    const by = artistNames.length === 1 ? `Also by ${artistNames[0]}` : "Also by artists you like";
    return suggestions.length === 1 ? by : `${by} — pick any`;
  });

  async function accept(): Promise<void> {
    if (sourceItemId === null || selectedIds.size === 0) return;
    // Snapshot the ids: destructured $props() reads are live, and onClosed()
    // nulls the parent state these props are bound to.
    const itemId = sourceItemId;
    const suggestionIds = [...selectedIds];
    onClosed();
    try {
      const { failedTitles } = await api.acceptSuggestions(itemId, suggestionIds);
      if (failedTitles.length > 0) {
        alert(`Couldn't add: ${failedTitles.join(", ")}`);
      }
    } catch {
      alert("Failed to add release.");
      return;
    }
    onAccepted();
  }

  async function dismiss(): Promise<void> {
    if (sourceItemId === null) return;
    const itemId = sourceItemId;
    // Turning down the prompt turns down every release it offered.
    const suggestionIds = suggestions.map((s) => s.id);
    onClosed();
    try {
      await api.dismissSuggestion(itemId, suggestionIds);
    } catch {
      alert("Failed to dismiss suggestion.");
    }
  }

  $effect(() => {
    if (!isOpen) return;
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") void dismiss();
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  });
</script>

<div id="suggestion-picker-modal" class="link-picker" hidden={!isOpen}>
  <div
    class="link-picker__backdrop"
    data-suggestion-picker-close="true"
    onclick={dismiss}
    role="presentation"
  ></div>
  <div
    class="link-picker__dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="suggestion-picker-title"
  >
    <div class="link-picker__header">
      <h2 id="suggestion-picker-title">You might also like</h2>
      <p id="suggestion-picker-message">{message}</p>
    </div>
    <div id="suggestion-picker-list" class="link-picker__list">
      {#each suggestions as suggestion (suggestion.id)}
        {@const isSelected = selectedIds.has(suggestion.id)}
        <button
          type="button"
          class="link-picker__candidate"
          class:is-selected={isSelected}
          data-suggestion-id={suggestion.id}
          aria-pressed={isSelected ? "true" : "false"}
          onclick={() => toggle(suggestion.id)}
        >
          <SuggestionArtwork {suggestion} />
          <span class="link-picker__candidate-main">
            <span class="link-picker__candidate-title"
              >{suggestion.title}{suggestion.year ? ` (${suggestion.year})` : ""}</span
            >
            <span class="link-picker__candidate-artist">{suggestion.artistName}</span>
          </span>
          <span class="link-picker__candidate-meta">
            <span class="badge badge--source">{suggestion.itemType}</span>
          </span>
        </button>
      {/each}
    </div>
    <div class="link-picker__actions">
      <button type="button" id="suggestion-picker-dismiss" class="btn btn--ghost" onclick={dismiss}
        >Dismiss</button
      >
      <button
        type="button"
        id="suggestion-picker-accept"
        class="btn btn--primary"
        disabled={selectedIds.size === 0}
        onclick={accept}
      >
        {selectedIds.size > 1 ? `Add ${selectedIds.size} to list` : "Add to list"}
      </button>
    </div>
  </div>
</div>

<script lang="ts">
  import type { ItemSuggestion } from "../../types";
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

  // The suggestion the "Add to list" button will take. Reset whenever the
  // prompt opens with a different set, so a stale id can't carry over.
  let selectedId = $state<number | null>(null);
  const suggestionsKey = $derived(suggestions.map((s) => s.id).join(","));

  $effect.pre(() => {
    void suggestionsKey;
    selectedId = suggestions[0]?.id ?? null;
  });

  const artistNames = $derived([...new Set(suggestions.map((s) => s.artistName))]);
  const message = $derived.by(() => {
    if (suggestions.length === 0) return "";
    const by = artistNames.length === 1 ? `Also by ${artistNames[0]}` : "Also by artists you like";
    return suggestions.length === 1 ? by : `${by} — pick one`;
  });

  async function accept(): Promise<void> {
    if (sourceItemId === null || selectedId === null) return;
    // Snapshot the ids: destructured $props() reads are live, and onClosed()
    // nulls the parent state these props are bound to.
    const itemId = sourceItemId;
    const suggestionId = selectedId;
    onClosed();
    try {
      await api.acceptSuggestion(itemId, suggestionId);
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
        {@const isSelected = suggestion.id === selectedId}
        <button
          type="button"
          class="link-picker__candidate"
          class:is-selected={isSelected}
          data-suggestion-id={suggestion.id}
          aria-pressed={isSelected ? "true" : "false"}
          onclick={() => (selectedId = suggestion.id)}
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
        disabled={selectedId === null}
        onclick={accept}
      >
        Add to list
      </button>
    </div>
  </div>
</div>

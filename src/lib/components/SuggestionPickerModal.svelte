<script lang="ts">
  import type { ItemSuggestion } from "../../types";
  import { api } from "../api";

  let {
    suggestion,
    sourceItemId,
    onAccepted,
    onClosed,
  }: {
    suggestion: ItemSuggestion | null;
    sourceItemId: number | null;
    onAccepted: () => void;
    onClosed: () => void;
  } = $props();

  const artworkUrl = $derived(
    suggestion?.musicbrainzReleaseId
      ? `https://coverartarchive.org/release/${encodeURIComponent(suggestion.musicbrainzReleaseId)}/front-250`
      : null,
  );

  let artworkFailed = $state(false);
  $effect.pre(() => {
    void suggestion;
    artworkFailed = false;
  });

  async function accept(): Promise<void> {
    if (sourceItemId === null) return;
    // Snapshot the id: destructured $props() reads are live, and onClosed()
    // nulls the parent state this prop is bound to.
    const itemId = sourceItemId;
    onClosed();
    try {
      await api.acceptSuggestion(itemId);
    } catch {
      alert("Failed to add release.");
      return;
    }
    onAccepted();
  }

  async function dismiss(): Promise<void> {
    if (sourceItemId === null) return;
    const itemId = sourceItemId;
    onClosed();
    try {
      await api.dismissSuggestion(itemId);
    } catch {
      alert("Failed to dismiss suggestion.");
    }
  }

  $effect(() => {
    if (!suggestion) return;
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") void dismiss();
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  });
</script>

<div id="suggestion-picker-modal" class="link-picker" hidden={!suggestion}>
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
      <p id="suggestion-picker-message">
        {suggestion ? `Also by ${suggestion.artistName}` : ""}
      </p>
    </div>
    <div id="suggestion-picker-list" class="link-picker__list" style="overflow-y: visible">
      {#if suggestion}
        <button type="button" class="link-picker__candidate is-selected" aria-pressed="true">
          {#if artworkUrl && !artworkFailed}
            <img
              src={artworkUrl}
              alt={suggestion.title}
              class="suggestion-picker__artwork"
              onerror={() => (artworkFailed = true)}
            />
          {/if}
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
      {/if}
    </div>
    <div class="link-picker__actions">
      <button type="button" id="suggestion-picker-dismiss" class="btn btn--ghost" onclick={dismiss}
        >Dismiss</button
      >
      <button type="button" id="suggestion-picker-accept" class="btn btn--primary" onclick={accept}>
        Add to list
      </button>
    </div>
  </div>
</div>

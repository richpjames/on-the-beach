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

  // Cover Art Archive is keyed by both release-group and release MBID, but the
  // two are nowhere near equally covered: a suggestion is one specific pressing
  // out of dozens, and most pressings have no scan uploaded, while the
  // release-group nearly always does. Ask the group first and only fall back to
  // the exact release — asking the release alone is why these prompts came up
  // blank most of the time.
  const artworkCandidates = $derived.by(() => {
    if (!suggestion) return [];
    const urls: string[] = [];
    if (suggestion.musicbrainzReleaseGroupId) {
      urls.push(
        `https://coverartarchive.org/release-group/${encodeURIComponent(suggestion.musicbrainzReleaseGroupId)}/front-250`,
      );
    }
    if (suggestion.musicbrainzReleaseId) {
      urls.push(
        `https://coverartarchive.org/release/${encodeURIComponent(suggestion.musicbrainzReleaseId)}/front-250`,
      );
    }
    return urls;
  });

  // Index into artworkCandidates; past the end means "give up, show no image".
  let candidateIndex = $state(0);
  let retried = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const artworkUrl = $derived(artworkCandidates[candidateIndex] ?? null);

  $effect.pre(() => {
    void suggestion;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    candidateIndex = 0;
    retried = false;
  });

  // CAA also serves the odd transient 5xx from its archive.org backend, which
  // reaches an <img> as the same bare `error` event as a genuine 404. One retry
  // pass over the whole list costs nothing and rescues those.
  function onArtworkError(): void {
    if (candidateIndex + 1 < artworkCandidates.length) {
      candidateIndex += 1;
      return;
    }
    // Dropping the <img> and re-adding it is what forces a fresh request; the
    // browser won't reload a src it has already failed on.
    candidateIndex = artworkCandidates.length;
    if (retried) return;
    retried = true;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      candidateIndex = 0;
    }, 800);
  }

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
          {#if artworkUrl}
            <img
              src={artworkUrl}
              alt={suggestion.title}
              class="suggestion-picker__artwork"
              onerror={onArtworkError}
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

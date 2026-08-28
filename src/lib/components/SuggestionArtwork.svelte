<script lang="ts">
  import type { ItemSuggestion } from "../../../domain/types";

  let { suggestion }: { suggestion: ItemSuggestion } = $props();

  // Cover Art Archive is keyed by both release-group and release MBID, but the
  // two are nowhere near equally covered: a suggestion is one specific pressing
  // out of dozens, and most pressings have no scan uploaded, while the
  // release-group nearly always does. Ask the group first and only fall back to
  // the exact release — asking the release alone is why these prompts came up
  // blank most of the time.
  const artworkCandidates = $derived.by(() => {
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
</script>

{#if artworkUrl}
  <img
    src={artworkUrl}
    alt={suggestion.title}
    class="suggestion-picker__artwork"
    onerror={onArtworkError}
  />
{/if}

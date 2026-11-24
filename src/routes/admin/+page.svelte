<script lang="ts">
  import { apiFetch } from "$lib/api";

  let { data } = $props();

  interface LinkSourceView {
    host: string;
    displayName: string;
    rank: number;
    firstSeenAt: string;
  }

  // svelte-ignore state_referenced_locally
  let sources = $state<LinkSourceView[]>([...data.linkSources]);
  let statusMessage = $state("");

  // Keep the list in the server's order — best-ranked first, ties by name —
  // so a re-rank visibly moves the row rather than leaving it where it was.
  function sortSources(rows: LinkSourceView[]): LinkSourceView[] {
    return [...rows].sort(
      (a, b) => b.rank - a.rank || a.displayName.localeCompare(b.displayName),
    );
  }

  async function saveRank(source: LinkSourceView, raw: string): Promise<void> {
    const rank = Number(raw);
    if (raw.trim() === "" || !Number.isInteger(rank)) {
      statusMessage = "Ranks must be whole numbers.";
      return;
    }
    statusMessage = "Saving…";
    try {
      const res = await apiFetch("/api/link-sources", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: source.host, rank }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        statusMessage = err.error || "Failed to save.";
        return;
      }
      sources = sortSources(
        sources.map((row) => (row.host === source.host ? { ...row, rank } : row)),
      );
      statusMessage = "Saved. The new ranking applies to the next lookup.";
    } catch {
      statusMessage = "Failed to save.";
    }
  }

  function firstSeenLabel(iso: string): string {
    return new Date(iso).toLocaleDateString();
  }
</script>

<svelte:head>
  <title>Admin — On The Beach</title>
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<main class="main main--scroll">
  <div class="settings">
    <a href="/" class="btn btn--ghost settings__back">◄ Back</a>

    <section class="settings__section" id="link-source-rankings">
      <h2 class="settings__heading">External link sources</h2>
      <p class="settings__hint">
        When a record's notes are empty, the first paragraph of its best-ranked MusicBrainz
        external link is fetched and kept as the notes. These are the sources met so far —
        set a rank to say which prose you trust most. The highest rank wins; a source ranked
        0 is still fetched when nothing better is attached. An unknown source only supplies
        notes when its first paragraph reads as a sentence — cookie and consent notices never
        count. New sources start at Wikipedia 11, Pitchfork 10, AllMusic 9, everything else 0.
      </p>

      {#if sources.length === 0}
        <p class="settings__hint" id="link-sources-empty">
          Nothing encountered yet. Sources appear here as records with MusicBrainz external
          links are added or opened.
        </p>
      {:else}
        <ul class="link-source-list" id="link-source-list">
          {#each sources as source (source.host)}
            <li class="link-source-list__row">
              <div class="link-source-list__main">
                <span class="link-source-list__name">{source.displayName}</span>
                <span class="link-source-list__meta">
                  <span class="link-source-list__host">{source.host}</span>
                  <span class="link-source-list__seen">first seen {firstSeenLabel(source.firstSeenAt)}</span>
                </span>
              </div>
              <label class="link-source-list__rank">
                <span>Rank</span>
                <input
                  type="number"
                  class="settings__number"
                  name="rank-{source.host}"
                  step="1"
                  inputmode="numeric"
                  value={source.rank}
                  onchange={(event) => saveRank(source, event.currentTarget.value)}
                />
              </label>
            </li>
          {/each}
        </ul>
      {/if}
      <p id="link-sources-status" class="settings__status" role="status" aria-live="polite">
        {statusMessage}
      </p>
    </section>
  </div>
</main>

<style>
  /* The rankings list: a sunken field of rows, the way the followed-artists
     panel reads — name and host on the left, the rank to set on the right.
     Rows wrap on narrow screens so the input never overflows the window. */
  .link-source-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    border-width: 2px;
    border-style: solid;
    border-color: var(--bevel-field);
    background: var(--chrome-light);
    max-height: 420px;
    overflow-y: auto;
  }

  .link-source-list__row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3);
    border-bottom: 1px solid var(--chrome-mid);
  }

  .link-source-list__row:last-child {
    border-bottom: none;
  }

  .link-source-list__main {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    flex: 1 1 160px;
    min-width: 0;
  }

  .link-source-list__name {
    font-size: var(--text-md);
  }

  .link-source-list__meta {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    font-size: var(--text-xs);
    color: var(--chrome-dark);
  }

  .link-source-list__host {
    font-family: var(--font-mono);
    overflow-wrap: anywhere;
  }

  .link-source-list__rank {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-md);
  }
</style>
<script lang="ts">
  import { tick } from "svelte";
  import type { MusicItemSort, MusicItemSortDirection } from "../../types";
  import type { FilterSelection } from "../../ui/domain/music-list";
  import type { appMachine } from "../../ui/state/app-machine";
  import type { MachineHandle } from "../use-machine.svelte";

  let {
    app,
    onPickRandom,
  }: {
    app: MachineHandle<typeof appMachine>;
    onPickRandom: () => Promise<{ id: number } | null>;
  } = $props();

  const ctx = $derived(app.snapshot.context);

  const FILTERS: Array<{ value: FilterSelection; label: string }> = [
    { value: "all", label: "All" },
    { value: "to-listen", label: "To Listen" },
    { value: "listened", label: "Listened" },
    { value: "scheduled", label: "Scheduled" },
  ];

  let browseToolsEl: HTMLElement | undefined = $state();
  let searchInputEl: HTMLInputElement | undefined = $state();

  function selectFilter(filter: FilterSelection): void {
    app.send({ type: "FILTER_SELECTED", filter });
    // If date-listened is selected but the filter changed away from listened,
    // reset to date-added.
    if (filter !== "listened" && ctx.currentSort === "date-listened") {
      app.send({ type: "SORT_UPDATED", sort: "date-added" });
    }
  }

  function onSearchInput(event: Event): void {
    app.send({ type: "SEARCH_UPDATED", query: (event.currentTarget as HTMLInputElement).value });
  }

  function clearSearch(): void {
    app.send({ type: "SEARCH_UPDATED", query: "" });
    searchInputEl?.focus();
  }

  function onSortChange(event: Event): void {
    app.send({
      type: "SORT_UPDATED",
      sort: (event.currentTarget as HTMLSelectElement).value as MusicItemSort,
    });
  }

  function toggleDirection(): void {
    const next: MusicItemSortDirection = ctx.currentSortDirection === "desc" ? "asc" : "desc";
    app.send({ type: "SORT_DIRECTION_UPDATED", direction: next });
  }

  function directionLabel(sort: MusicItemSort, direction: MusicItemSortDirection): string {
    const isDate = sort === "date-added" || sort === "date-listened";
    if (isDate) return direction === "desc" ? "↓ Newest first" : "↑ Oldest first";
    if (sort === "star-rating") return direction === "desc" ? "↓ Highest first" : "↑ Lowest first";
    return direction === "asc" ? "↑ A–Z" : "↓ Z–A";
  }

  function directionAriaLabel(sort: MusicItemSort, direction: MusicItemSortDirection): string {
    const isDate = sort === "date-added" || sort === "date-listened";
    if (isDate) {
      return direction === "desc"
        ? "Sort direction: newest first"
        : "Sort direction: oldest first";
    }
    if (sort === "star-rating") {
      return direction === "desc"
        ? "Sort direction: highest first"
        : "Sort direction: lowest first";
    }
    return direction === "asc" ? "Sort direction: A to Z" : "Sort direction: Z to A";
  }

  function toggleSearchPanel(): void {
    app.send({ type: "SEARCH_PANEL_TOGGLED" });
    if (!ctx.searchPanelOpen) return;
    tick().then(() => searchInputEl?.focus());
  }

  // ── Random pick ────────────────────────────────────────────────────────────
  let randomBtnText = $state("🎲 Pick One");
  let randomBtnDisabled = $state(false);

  async function pickRandom(): Promise<void> {
    if (randomBtnDisabled) return;
    randomBtnDisabled = true;
    try {
      const picked = await onPickRandom();
      if (!picked) {
        randomBtnText = "🎲 Nothing yet";
        setTimeout(() => {
          randomBtnText = "🎲 Pick One";
          randomBtnDisabled = false;
        }, 1500);
      }
    } finally {
      if (randomBtnText === "🎲 Pick One") {
        randomBtnDisabled = false;
      }
    }
  }

  $effect(() => {
    const onDocumentClick = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !(browseToolsEl instanceof HTMLElement)) return;
      if (!browseToolsEl.contains(target)) {
        app.send({ type: "BROWSE_PANELS_CLOSED" });
      }
    };
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        app.send({ type: "BROWSE_PANELS_CLOSED" });
      }
    };
    document.addEventListener("click", onDocumentClick);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("click", onDocumentClick);
      document.removeEventListener("keydown", onEscape);
    };
  });
</script>

<section class="filter-section">
  <div class="browse-controls">
    <div id="filter-bar" class="filter-bar">
      {#each FILTERS as { value, label } (value)}
        <button
          class="filter-btn{value === ctx.currentFilter ? ' active' : ''}"
          data-filter={value}
          onclick={() => selectFilter(value)}>{label}</button
        >
      {/each}
      <button
        type="button"
        id="pick-random-btn"
        class="filter-btn filter-btn--action"
        title="Pick a random item from To Listen"
        aria-label="Pick a random item from To Listen"
        disabled={randomBtnDisabled}
        onclick={pickRandom}>{randomBtnText}</button
      >
    </div>
    <div class="browse-tools" bind:this={browseToolsEl}>
      <div class="browse-tools__mobile-actions">
        <button
          type="button"
          id="browse-search-toggle"
          class="browse-tools__icon-btn"
          aria-label="Toggle search"
          aria-controls="browse-search-panel"
          aria-expanded={ctx.searchPanelOpen ? "true" : "false"}
          onclick={toggleSearchPanel}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="10" cy="10" r="5.5"></circle>
            <path d="M14.5 14.5L20 20"></path>
            <path d="M7.5 10H12.5"></path>
            <path d="M10 7.5V12.5"></path>
          </svg>
        </button>
        <button
          type="button"
          id="browse-sort-toggle"
          class="browse-tools__icon-btn"
          aria-label="Toggle sort"
          aria-controls="browse-sort-panel"
          aria-expanded={ctx.sortPanelOpen ? "true" : "false"}
          onclick={() => app.send({ type: "SORT_PANEL_TOGGLED" })}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 4V20"></path>
            <path d="M5 7L8 4L11 7"></path>
            <path d="M16 20V4"></path>
            <path d="M13 17L16 20L19 17"></path>
          </svg>
        </button>
      </div>
      <div
        id="browse-search-panel"
        class="browse-tools__panel browse-tools__panel--search"
        class:is-open={ctx.searchPanelOpen}
      >
        <div class="browse-tools__search-wrap">
          <input
            type="search"
            id="browse-search"
            class="input browse-tools__search"
            placeholder="Search releases or lists..."
            aria-label="Search releases or lists"
            value={ctx.searchQuery}
            oninput={onSearchInput}
            bind:this={searchInputEl}
          />
          <button
            type="button"
            id="search-clear-btn"
            class="browse-tools__search-clear"
            aria-label="Clear search"
            style:display={ctx.searchQuery ? undefined : "none"}
            onclick={clearSearch}>&#x2715;</button
          >
        </div>
      </div>
      <div
        id="browse-sort-panel"
        class="browse-tools__panel browse-tools__panel--sort"
        class:is-open={ctx.sortPanelOpen}
      >
        <label class="browse-tools__sort" for="browse-sort">
          <select id="browse-sort" class="input" value={ctx.currentSort} onchange={onSortChange}>
            <option value="date-added">Date added</option>
            <option
              value="date-listened"
              id="sort-option-date-listened"
              hidden={ctx.currentFilter !== "listened"}>Date listened</option
            >
            <option value="artist-name">Artist A–Z</option>
            <option value="release-name">Release A–Z</option>
            <option value="star-rating">Star rating</option>
          </select>
        </label>
        <button
          type="button"
          id="sort-direction-btn"
          class="btn btn--ghost browse-tools__direction-btn"
          aria-label={directionAriaLabel(ctx.currentSort, ctx.currentSortDirection)}
          data-direction={ctx.currentSortDirection}
          onclick={toggleDirection}
          >{directionLabel(ctx.currentSort, ctx.currentSortDirection)}</button
        >
      </div>
    </div>
  </div>
</section>

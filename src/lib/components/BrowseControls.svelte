<script lang="ts">
  import { tick } from "svelte";
  import type { MusicItemSort, MusicItemSortDirection } from "../../../domain/types";
  import type { FilterSelection, PickRatingRange } from "../../../domain/types";
  import {
    FULL_PICK_RANGE,
    makePickRange,
    PICK_RATING_STEPS,
    pickRangeAriaLabel,
    pickRangeLabel,
    ratingStars,
  } from "../../ui/logic/pick-one";
  import type { appMachine } from "../../ui/state/app-machine";
  import type { MachineHandle } from "../use-machine.svelte";

  let {
    app,
    onPickRandom,
  }: {
    app: MachineHandle<typeof appMachine>;
    onPickRandom: (range?: PickRatingRange | null) => Promise<{ id: number } | null>;
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
  //
  // Pick One rolls over the list as it stands — whatever filter, stack and
  // search are applied — and press-and-hold narrows that to a star range. The
  // range lives in machine context (and from there in the URL), so it is still
  // set when the user comes back from the release a roll landed on.
  const PICK_LABEL = "🎲 Pick One";
  const LONG_PRESS_MS = 450;

  type RollMiss = "none" | "empty" | "no-matches";

  let rolling = $state(false);
  let rollMiss = $state<RollMiss>("none");
  let ratingMenuOpen = $state(false);
  let pickRandomEl: HTMLElement | undefined = $state();
  let rangeMinEl: HTMLSelectElement | undefined = $state();
  let longPressTimer: ReturnType<typeof setTimeout> | undefined;
  let missTimer: ReturnType<typeof setTimeout> | undefined;
  let longPressFired = false;

  const pickRange = $derived(ctx.pickRange);
  /** The menu's two ends: the live range, or the widest window to start from. */
  const rangeDraft = $derived(ctx.pickRange ?? FULL_PICK_RANGE);
  const rangeLabel = $derived(pickRangeLabel(ctx.pickRange));

  const randomBtnText = $derived(
    rolling
      ? "🎲 Rolling…"
      : rollMiss === "empty"
        ? "🎲 Nothing yet"
        : rollMiss === "no-matches"
          ? "🎲 No matches"
          : PICK_LABEL,
  );
  /** The live range, worn on the button so a retained window is never a surprise. */
  const rangeBadge = $derived(rolling || rollMiss !== "none" ? null : rangeLabel);
  const randomBtnDisabled = $derived(rolling || rollMiss !== "none");
  const randomBtnAriaLabel = $derived(
    `Pick a random release from the list, rated ${pickRangeAriaLabel(ctx.pickRange)}. ` +
      "Press and hold to choose a rating range.",
  );

  function openRatingMenu(): void {
    if (randomBtnDisabled) return;
    ratingMenuOpen = true;
  }

  function closeRatingMenu(): void {
    ratingMenuOpen = false;
  }

  function startLongPress(): void {
    longPressFired = false;
    clearLongPress();
    longPressTimer = setTimeout(() => {
      longPressFired = true;
      openRatingMenu();
    }, LONG_PRESS_MS);
  }

  function clearLongPress(): void {
    if (longPressTimer !== undefined) {
      clearTimeout(longPressTimer);
      longPressTimer = undefined;
    }
  }

  function onPickRandomClick(): void {
    // Suppress the click that follows a long-press (it already opened the menu).
    if (longPressFired) {
      longPressFired = false;
      return;
    }
    void roll();
  }

  function onPickRandomContextMenu(event: Event): void {
    // Prevent the native context / callout menu so hold-to-open works everywhere.
    event.preventDefault();
    clearLongPress();
    longPressFired = true;
    openRatingMenu();
  }

  /** Down-arrow opens the range menu — the keyboard's stand-in for a long press. */
  function onPickRandomKeydown(event: KeyboardEvent): void {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    clearLongPress();
    openRatingMenu();
    tick().then(() => rangeMinEl?.focus());
  }

  /**
   * Move one end of the range, pushing the other along rather than crossing it,
   * so "from 5" reads as "5 stars" instead of quietly widening the window.
   */
  function moveRangeEdge(edge: "min" | "max", value: number): void {
    const { min, max } = rangeDraft;
    const next =
      edge === "min"
        ? makePickRange(value, Math.max(value, max))
        : makePickRange(Math.min(value, min), value);
    app.send({ type: "PICK_RANGE_UPDATED", range: next });
  }

  function onRangeEdgeChange(edge: "min" | "max", event: Event): void {
    moveRangeEdge(edge, Number((event.currentTarget as HTMLSelectElement).value));
  }

  function clearRange(): void {
    app.send({ type: "PICK_RANGE_UPDATED", range: null });
  }

  function rollFromMenu(): void {
    closeRatingMenu();
    void roll();
  }

  async function roll(): Promise<void> {
    if (randomBtnDisabled) return;
    const range = ctx.pickRange;
    rolling = true;
    try {
      const picked = await onPickRandom(range);
      if (!picked) {
        // Nothing came back: with no range the list itself is empty, with one
        // it's the range that ruled everything out.
        rollMiss = range === null ? "empty" : "no-matches";
        missTimer = setTimeout(() => {
          rollMiss = "none";
        }, 1500);
      }
    } finally {
      rolling = false;
    }
  }

  $effect(() => {
    const onDocumentClick = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !(browseToolsEl instanceof HTMLElement)) return;
      if (!browseToolsEl.contains(target)) {
        app.send({ type: "BROWSE_PANELS_CLOSED" });
      }
      if (pickRandomEl instanceof HTMLElement && !pickRandomEl.contains(target)) {
        closeRatingMenu();
      }
    };
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        app.send({ type: "BROWSE_PANELS_CLOSED" });
        closeRatingMenu();
      }
    };
    document.addEventListener("click", onDocumentClick);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("click", onDocumentClick);
      document.removeEventListener("keydown", onEscape);
      clearLongPress();
      if (missTimer !== undefined) clearTimeout(missTimer);
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
      <div class="pick-random" bind:this={pickRandomEl}>
        <button
          type="button"
          id="pick-random-btn"
          class="filter-btn filter-btn--action"
          title="Pick a random release from the list — hold to pick by rating"
          aria-label={randomBtnAriaLabel}
          aria-haspopup="dialog"
          aria-expanded={ratingMenuOpen ? "true" : "false"}
          aria-controls="pick-range-menu"
          data-pick-range={pickRange === null ? "any" : `${pickRange.min}-${pickRange.max}`}
          disabled={randomBtnDisabled}
          onclick={onPickRandomClick}
          onkeydown={onPickRandomKeydown}
          onpointerdown={startLongPress}
          onpointerup={clearLongPress}
          onpointerleave={clearLongPress}
          onpointercancel={clearLongPress}
          oncontextmenu={onPickRandomContextMenu}
          >{randomBtnText}{#if rangeBadge}<span class="pick-random__badge">{rangeBadge}</span
            >{/if}</button
        >
        {#if ratingMenuOpen}
          <div
            id="pick-range-menu"
            class="pick-random__menu"
            role="dialog"
            aria-label="Pick one rated"
          >
            <div class="pick-random__menu-heading">Pick one rated…</div>
            <label class="pick-random__range" for="pick-range-min">
              <span class="pick-random__range-label">From</span>
              <select
                id="pick-range-min"
                class="input pick-random__range-select"
                bind:this={rangeMinEl}
                value={rangeDraft.min}
                onchange={(event) => onRangeEdgeChange("min", event)}
              >
                {#each PICK_RATING_STEPS as option (option)}
                  <option value={option}>{ratingStars(option)} {option}</option>
                {/each}
              </select>
            </label>
            <label class="pick-random__range" for="pick-range-max">
              <span class="pick-random__range-label">To</span>
              <select
                id="pick-range-max"
                class="input pick-random__range-select"
                value={rangeDraft.max}
                onchange={(event) => onRangeEdgeChange("max", event)}
              >
                {#each PICK_RATING_STEPS as option (option)}
                  <option value={option}>{ratingStars(option)} {option}</option>
                {/each}
              </select>
            </label>
            <div class="pick-random__menu-actions">
              <button
                type="button"
                id="pick-range-any"
                class="btn pick-random__menu-btn{pickRange === null ? ' is-active' : ''}"
                aria-pressed={pickRange === null}
                onclick={clearRange}>Any rating</button
              >
              <button
                type="button"
                id="pick-range-roll"
                class="btn pick-random__menu-btn"
                onclick={rollFromMenu}>🎲 Roll</button
              >
            </div>
          </div>
        {/if}
      </div>
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

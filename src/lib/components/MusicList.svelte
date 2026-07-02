<script lang="ts">
  import Sortable from "sortablejs";
  import { onMount } from "svelte";
  import type { ListenStatus, MusicItemFull, StackWithCount } from "../../types";
  import type { FilterSelection } from "../../ui/domain/music-list";
  import { getEmptyStateMessage } from "../../ui/domain/music-list";
  import { api } from "../api";
  import FolderRow from "./FolderRow.svelte";
  import MusicCard from "./MusicCard.svelte";
  import VerticalScrollbar from "./VerticalScrollbar.svelte";

  let {
    items,
    childStacks,
    breadcrumbs,
    stacks,
    currentStack,
    currentFilter,
    searchQuery,
    orderLocked,
    onSelectStack,
    onRefreshList,
    onStacksChanged,
    onStatusChanged,
    onDelete,
    onReorder,
  }: {
    items: MusicItemFull[];
    childStacks: Array<{ id: number; name: string; item_count: number }>;
    breadcrumbs: Array<{ id: number; name: string }>;
    stacks: StackWithCount[];
    currentStack: number | null;
    currentFilter: FilterSelection;
    searchQuery: string;
    orderLocked: boolean;
    onSelectStack: (stackId: number) => void;
    onRefreshList: () => void;
    onStacksChanged: () => Promise<void>;
    onStatusChanged: (itemId: number, status: ListenStatus) => Promise<void>;
    onDelete: (itemId: number) => Promise<void>;
    onReorder: (entries: string[]) => Promise<void>;
  } = $props();

  let listEl: HTMLElement | undefined = $state();
  let sortable: Sortable | null = null;

  onMount(() => {
    if (!listEl) return;

    sortable = Sortable.create(listEl, {
      draggable: ".music-card, .folder-row",
      animation: 160,
      fallbackTolerance: 4,
      invertSwap: true,
      swapThreshold: 0.35,
      // Keep interactive controls clickable while making the card body draggable.
      filter:
        "button:not(.music-card__reorder-handle):not(.folder-row__reorder-handle),input,select,textarea,[data-action],.music-card__menu-item",
      preventOnFilter: false,
      ghostClass: "music-card--drag-ghost",
      chosenClass: "music-card--drag-chosen",
      dragClass: "music-card--dragging",
      onEnd: (event: Sortable.SortableEvent) => {
        if (event.oldDraggableIndex === event.newDraggableIndex) {
          return;
        }
        // Sortable owns the DOM move (as in the pre-SvelteKit shell); we only
        // persist the new order. The next list refetch re-renders from state.
        const entries = readOrderEntries();
        if (entries.length === 0) {
          return;
        }
        void persistOrder(entries);
      },
    });

    // Use a drag handle on narrow screens and on touch devices (e.g. iPad), so a
    // swipe anywhere on a card scrolls the list instead of starting a reorder.
    const reorderMediaQuery = window.matchMedia("(max-width: 520px), (pointer: coarse)");
    const syncHandleMode = (): void => {
      sortable?.option(
        "handle",
        reorderMediaQuery.matches
          ? ".music-card__reorder-handle, .folder-row__reorder-handle"
          : undefined,
      );
    };
    reorderMediaQuery.addEventListener("change", syncHandleMode);
    syncHandleMode();

    return () => {
      reorderMediaQuery.removeEventListener("change", syncHandleMode);
      sortable?.destroy();
      sortable = null;
    };
  });

  $effect(() => {
    sortable?.option("disabled", orderLocked);
  });

  function readOrderEntries(): string[] {
    if (!listEl) {
      return [];
    }

    const entries: string[] = [];
    const seen = new Set<string>();
    for (const el of listEl.querySelectorAll<HTMLElement>("[data-item-id], [data-child-stack-id]")) {
      let entry: string | null = null;
      if (el.classList.contains("music-card") && el.dataset.itemId) {
        const id = Number(el.dataset.itemId);
        if (Number.isInteger(id) && id > 0) entry = `i:${id}`;
      } else if (el.classList.contains("folder-row") && el.dataset.childStackId) {
        const id = Number(el.dataset.childStackId);
        if (Number.isInteger(id) && id > 0) entry = `s:${id}`;
      }
      if (entry && !seen.has(entry)) {
        seen.add(entry);
        entries.push(entry);
      }
    }

    return entries;
  }

  async function persistOrder(entries: string[]): Promise<void> {
    if (orderLocked) {
      return;
    }

    await onReorder(entries);
  }

  // ── Child stack picker ("+ Add list") ─────────────────────────────────────
  let childPickerOpen = $state(false);
  let childPickerCandidates = $state<StackWithCount[]>([]);

  async function toggleChildPicker(): Promise<void> {
    if (childPickerOpen) {
      childPickerOpen = false;
      return;
    }
    if (currentStack === null) return;

    const existingChildren = await api.getStackChildren(currentStack);
    const existingChildIds = new Set(existingChildren.map((c) => c.id));
    childPickerCandidates = stacks.filter(
      (s) => s.id !== currentStack && !existingChildIds.has(s.id),
    );
    childPickerOpen = true;
  }

  async function addChildStack(childStackId: number): Promise<void> {
    if (currentStack === null) return;
    try {
      await api.addStackParent(childStackId, currentStack);
      childPickerOpen = false;
      onRefreshList();
    } catch (error) {
      console.error("Failed to add child stack:", error);
      alert("Failed to add list. It may create a cycle.");
    }
  }

  async function removeChildStack(childStackId: number): Promise<void> {
    if (currentStack === null) return;
    try {
      await api.removeStackParent(childStackId, currentStack);
      onRefreshList();
    } catch (error) {
      console.error("Failed to remove child stack:", error);
    }
  }

  $effect(() => {
    if (!childPickerOpen) return;
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") childPickerOpen = false;
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  });

  function formatItemCount(count: number): string {
    return count === 1 ? "1 item" : `${count} items`;
  }
</script>

<section class="list-section">
  <div class="music-list-shell">
    <div id="music-list" class="music-list" bind:this={listEl}>
      {#if breadcrumbs.length > 0}
        <nav class="breadcrumb" aria-label="List navigation">
          {#each breadcrumbs as crumb, index (crumb.id)}
            {#if index < breadcrumbs.length - 1}
              <button
                type="button"
                class="breadcrumb__link"
                data-breadcrumb-stack={crumb.id}
                onclick={() => onSelectStack(crumb.id)}>{crumb.name}</button
              ><span class="breadcrumb__sep"> &gt; </span>
            {:else}
              <span class="breadcrumb__current">{crumb.name}</span>
            {/if}
          {/each}
        </nav>
      {/if}
      {#if currentStack !== null}
        <button
          type="button"
          id="add-child-stack-btn"
          class="btn btn--ghost add-child-stack-btn"
          title="Add a list into this list"
          onclick={toggleChildPicker}>+ Add list</button
        >
        {#if childPickerOpen}
          <div class="child-stack-picker">
            {#if childPickerCandidates.length === 0}
              <div class="child-stack-picker__empty">No lists available to add.</div>
            {:else}
              {#each childPickerCandidates as stack (stack.id)}
                <button
                  type="button"
                  class="child-stack-picker__item"
                  data-picker-stack-id={stack.id}
                  onclick={() => addChildStack(stack.id)}
                >
                  <span class="child-stack-picker__name">{stack.name}</span>
                  <span class="child-stack-picker__count">{formatItemCount(stack.item_count)}</span>
                </button>
              {/each}
            {/if}
          </div>
        {/if}
      {/if}
      {#each childStacks as child (child.id)}
        <FolderRow {child} onOpen={onSelectStack} onRemove={removeChildStack} />
      {/each}
      {#if items.length === 0}
        <div class="empty-state">
          <p>{getEmptyStateMessage(currentFilter, searchQuery)}</p>
        </div>
      {:else}
        {#each items as item (item.id)}
          <MusicCard
            {item}
            {onStatusChanged}
            {onDelete}
            {onStacksChanged}
            onStackDropdownClosed={onRefreshList}
          />
        {/each}
      {/if}
    </div>
    <VerticalScrollbar
      target={listEl}
      id="music-list-scrollbar"
      trackId="music-list-scroll-track"
      thumbId="music-list-scroll-thumb"
      buttonAttr="data-scroll-btn"
      syncKey={items}
    />
  </div>
</section>

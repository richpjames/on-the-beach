<script lang="ts">
  import { tick } from "svelte";
  import type { StackWithCount } from "../../types";
  import HorizontalScrollbar from "./HorizontalScrollbar.svelte";

  let {
    stacks,
    currentStack,
    searchQuery,
    manageOpen,
    onSelectAll,
    onSelectStack,
    onDeleteStack,
    onToggleManage,
  }: {
    stacks: StackWithCount[];
    currentStack: number | null;
    searchQuery: string;
    manageOpen: boolean;
    onSelectAll: () => void;
    onSelectStack: (stackId: number) => void;
    onDeleteStack: (stackId: number) => Promise<void>;
    onToggleManage: () => void;
  } = $props();

  let barEl: HTMLElement | undefined = $state();

  const normalizedQuery = $derived(searchQuery.trim().toLowerCase());
  const visibleStacks = $derived(
    normalizedQuery
      ? stacks.filter(
          (stack) =>
            stack.id === currentStack || stack.name.toLowerCase().includes(normalizedQuery),
        )
      : stacks,
  );
  const selectedStack = $derived(stacks.find((stack) => stack.id === currentStack));

  // Keep the active tab visible when the selection changes.
  $effect(() => {
    void currentStack;
    void visibleStacks;
    tick().then(() => {
      if (!barEl) return;
      const activeBtn = barEl.querySelector(".stack-tab.active");
      if (!(activeBtn instanceof HTMLElement)) return;
      const tabLeft = activeBtn.offsetLeft;
      const tabRight = tabLeft + activeBtn.offsetWidth;
      if (tabLeft < barEl.scrollLeft) {
        barEl.scrollLeft = tabLeft;
      } else if (tabRight > barEl.scrollLeft + barEl.clientWidth) {
        barEl.scrollLeft = tabRight - barEl.clientWidth;
      }
    });
  });
</script>

<div class="stack-bar-shell">
  <div id="stack-bar" class="stack-bar" bind:this={barEl}>
    <button
      class="stack-tab{currentStack === null ? ' active' : ''}"
      data-stack="all"
      onclick={onSelectAll}>All</button
    >
    {#each visibleStacks as stack (stack.id)}
      <button
        class="stack-tab{currentStack === stack.id ? ' active' : ''}"
        data-stack-id={stack.id}
        onclick={() => onSelectStack(stack.id)}>{stack.name}</button
      >
    {/each}
    <button
      class="stack-tab stack-tab--manage"
      id="manage-stacks-btn"
      title="Manage stacks"
      onclick={onToggleManage}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <circle cx="12" cy="12" r="3"></circle>
        <path
          d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
        ></path>
      </svg>
    </button>
    <button
      class="stack-tab stack-tab--delete"
      id="delete-stack-btn"
      title={selectedStack ? `Delete "${selectedStack.name}"` : "Delete selected stack"}
      hidden={!selectedStack}
      disabled={!selectedStack}
      aria-label="Delete selected stack"
      onclick={() => {
        if (currentStack !== null) void onDeleteStack(currentStack);
      }}
    >
      🗑
    </button>
  </div>
  <HorizontalScrollbar
    target={barEl}
    id="stack-bar-scrollbar"
    trackId="stack-bar-scroll-track"
    thumbId="stack-bar-scroll-thumb"
    syncKey={visibleStacks}
  />
</div>

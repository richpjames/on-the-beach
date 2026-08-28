<script lang="ts" module>
  /**
   * How far the bar was scrolled, kept outside the component instance.
   *
   * Picking a stack is a real navigation between routes, so the bar is torn
   * down and rebuilt; without this the tabs snap back to the left every time
   * one is clicked, dragging the tab out from under the pointer.
   */
  let lastScrollLeft = 0;
</script>

<script lang="ts">
  import { tick } from "svelte";
  import type { StackWithCount } from "../../../domain/types";
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

  // The bar is a two-row grid that flows left-to-right, so tabs read in
  // alphabetical order along the top row before wrapping onto the second one.
  // Row-wise flow needs an explicit column count: the first column is pinned to
  // "All" (row 1) and the manage cog (row 2), and the remaining tabs — the
  // stacks plus the delete tab — split across both rows. The delete tab counts
  // even while it is hidden: letting the count change when a stack is selected
  // re-wraps every tab and lurches the bar sideways. Its reserved column is
  // `max-content`, so it takes no width until the tab actually shows.
  const flowingTabCount = $derived(visibleStacks.length + 1);
  const columnCount = $derived(1 + Math.ceil(flowingTabCount / 2));

  // Keep the active tab visible when the selection changes. Only when it
  // changes: re-running this on every stack refresh would yank the bar back to
  // the active tab under a user who had scrolled somewhere else.
  let revealedStack: number | null | undefined = undefined;
  $effect(() => {
    const stack = currentStack;
    void visibleStacks;
    if (stack === revealedStack) return;
    tick().then(() => {
      if (!barEl) return;
      const activeBtn = barEl.querySelector(".stack-tab.active");
      // The tab for a deep-linked stack only exists once the stacks load; keep
      // trying until it does, then remember we've revealed this selection.
      if (!(activeBtn instanceof HTMLElement)) return;
      revealedStack = stack;
      const tabLeft = activeBtn.offsetLeft;
      const tabRight = tabLeft + activeBtn.offsetWidth;
      if (tabLeft < barEl.scrollLeft) {
        barEl.scrollLeft = tabLeft;
      } else if (tabRight > barEl.scrollLeft + barEl.clientWidth) {
        barEl.scrollLeft = tabRight - barEl.clientWidth;
      }
    });
  });

  // Put the bar back where it was after the navigation that rebuilt it, once
  // enough tabs have rendered for the offset to survive being set.
  let restoredScroll = false;
  $effect(() => {
    void visibleStacks;
    if (restoredScroll || !barEl) return;
    if (lastScrollLeft === 0 || barEl.scrollWidth <= barEl.clientWidth) return;
    barEl.scrollLeft = lastScrollLeft;
    restoredScroll = true;
  });

  function rememberScroll(): void {
    if (barEl) lastScrollLeft = barEl.scrollLeft;
  }

  /**
   * Take focus by hand so the browser doesn't scroll the pressed tab into
   * view: clicking a half-visible tab (or the cog, pinned to the far left)
   * would otherwise yank the whole bar sideways mid-click. Keyboard focus
   * still scrolls, which is how a tabbing user finds the tab they landed on.
   */
  function focusWithoutScrolling(event: MouseEvent): void {
    event.preventDefault();
    (event.currentTarget as HTMLElement).focus({ preventScroll: true });
  }
</script>

<div class="stack-bar-shell">
  <div
    id="stack-bar"
    class="stack-bar"
    style="--stack-bar-columns: {columnCount}"
    bind:this={barEl}
    onscroll={rememberScroll}
  >
    <button
      class="stack-tab{currentStack === null ? ' active' : ''}"
      data-stack="all"
      onmousedown={focusWithoutScrolling}
      onclick={onSelectAll}>All</button
    >
    {#each visibleStacks as stack (stack.id)}
      <button
        class="stack-tab{currentStack === stack.id ? ' active' : ''}"
        data-stack-id={stack.id}
        onmousedown={focusWithoutScrolling}
        onclick={() => onSelectStack(stack.id)}>{stack.name}</button
      >
    {/each}
    <button
      class="stack-tab stack-tab--manage"
      id="manage-stacks-btn"
      title="Manage stacks"
      onmousedown={focusWithoutScrolling}
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
      onmousedown={focusWithoutScrolling}
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

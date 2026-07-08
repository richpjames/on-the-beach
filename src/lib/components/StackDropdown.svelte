<script lang="ts">
  import { onMount } from "svelte";
  import type { StackWithCount } from "../../types";

  let {
    stacks,
    selectedStackIds,
    onToggle,
    onCreate,
    onClose,
    shouldIgnoreOutsideClick,
    anchorTop,
    flipUpIfClipped = false,
  }: {
    stacks: StackWithCount[];
    selectedStackIds: Set<number>;
    onToggle: (stackId: number, checked: boolean) => Promise<void> | void;
    onCreate: (name: string) => Promise<void>;
    /** Called when the dropdown wants to close (outside click / Escape). */
    onClose: () => void;
    shouldIgnoreOutsideClick?: (target: HTMLElement) => boolean;
    /** Optional explicit CSS top (px) relative to the positioned container. */
    anchorTop?: number;
    flipUpIfClipped?: boolean;
  } = $props();

  let dropdownEl: HTMLElement | undefined = $state();
  let query = $state("");

  const trimmedQuery = $derived(query.trim().toLowerCase());
  const visibleStacks = $derived(
    trimmedQuery === ""
      ? stacks
      : stacks.filter((stack) => stack.name.toLowerCase().includes(trimmedQuery)),
  );
  const exactMatch = $derived(
    stacks.find((stack) => stack.name.toLowerCase() === trimmedQuery),
  );

  onMount(() => {
    if (dropdownEl && flipUpIfClipped) {
      // Deferred so layout is settled before measuring.
      import("../popover").then(({ flipPopoverUpIfClipped }) => {
        if (dropdownEl) flipPopoverUpIfClipped(dropdownEl);
      });
    }

    const onDocumentClick = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (dropdownEl?.contains(target) || shouldIgnoreOutsideClick?.(target)) return;
      onClose();
    };

    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };

    document.addEventListener("keydown", onEscape);
    // Deferred so the click that opened the dropdown doesn't immediately close it.
    const timer = setTimeout(() => {
      document.addEventListener("click", onDocumentClick);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", onEscape);
      document.removeEventListener("click", onDocumentClick);
    };
  });

  async function onSearchKeydown(event: KeyboardEvent): Promise<void> {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const name = query.trim();
    if (!name) return;

    // An exact name match toggles that list instead of creating a duplicate.
    const match = exactMatch;
    if (match) {
      await onToggle(match.id, !selectedStackIds.has(match.id));
      query = "";
      return;
    }

    await onCreate(name);
    query = "";
  }
</script>

<div
  class="stack-dropdown"
  bind:this={dropdownEl}
  style={anchorTop !== undefined ? `top: ${anchorTop}px` : undefined}
>
  <div class="stack-dropdown__search">
    <input
      type="text"
      class="stack-dropdown__new-input input"
      placeholder="Search or add a list..."
      bind:value={query}
      onkeydown={onSearchKeydown}
    />
  </div>
  <div class="stack-dropdown__list">
    {#each visibleStacks as stack (stack.id)}
      <!-- Keyboard access is preserved: the nested checkbox is focusable and
           Space fires a click that bubbles to this handler. -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <label
        class="stack-dropdown__item"
        onclick={(event) => {
          // Toggle explicitly so clicking anywhere on the row — the name text,
          // the padding, or the box — reliably flips the assignment exactly
          // once. Relying on the browser's native <label>→checkbox forwarding
          // dropped text clicks in some browsers (e.g. Safari), so the box
          // was the only thing that worked. preventDefault stops the native
          // toggle; the checkbox stays a controlled reflection of state.
          event.preventDefault();
          onToggle(stack.id, !selectedStackIds.has(stack.id));
        }}
      >
        <input
          type="checkbox"
          class="stack-dropdown__checkbox"
          data-stack-id={stack.id}
          checked={selectedStackIds.has(stack.id)}
        />
        {stack.name}
      </label>
    {/each}
  </div>
  {#if trimmedQuery !== "" && visibleStacks.length === 0}
    <p class="stack-dropdown__empty">Press Enter to create it.</p>
  {/if}
</div>

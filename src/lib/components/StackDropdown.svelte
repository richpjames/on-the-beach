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
  let newStackName = $state("");

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

  async function onNewStackKeydown(event: KeyboardEvent): Promise<void> {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const name = newStackName.trim();
    if (!name) return;
    await onCreate(name);
    newStackName = "";
  }
</script>

<div
  class="stack-dropdown"
  bind:this={dropdownEl}
  style={anchorTop !== undefined ? `top: ${anchorTop}px` : undefined}
>
  <div class="stack-dropdown__list">
    {#each stacks as stack (stack.id)}
      <label class="stack-dropdown__item">
        <input
          type="checkbox"
          class="stack-dropdown__checkbox"
          data-stack-id={stack.id}
          checked={selectedStackIds.has(stack.id)}
          onchange={(e) => onToggle(stack.id, e.currentTarget.checked)}
        />
        {stack.name}
      </label>
    {/each}
  </div>
  <div class="stack-dropdown__new">
    <input
      type="text"
      class="stack-dropdown__new-input input"
      placeholder="New stack..."
      bind:value={newStackName}
      onkeydown={onNewStackKeydown}
    />
  </div>
</div>

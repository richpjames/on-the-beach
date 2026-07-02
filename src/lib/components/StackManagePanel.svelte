<script lang="ts">
  import { tick } from "svelte";
  import type { StackWithCount } from "../../types";
  import { api } from "../api";

  let {
    open,
    stacks,
    searchQuery,
    onStacksChanged,
    onDeleteStack,
  }: {
    open: boolean;
    stacks: StackWithCount[];
    searchQuery: string;
    /** Stacks were created/renamed — refresh the app's stack list. */
    onStacksChanged: () => Promise<void>;
    onDeleteStack: (stackId: number) => Promise<void>;
  } = $props();

  let newStackName = $state("");
  let renamingStackId = $state<number | null>(null);
  let renameValue = $state("");
  let renameInputEl: HTMLInputElement | undefined = $state();

  const normalizedQuery = $derived(searchQuery.trim().toLowerCase());
  const visibleStacks = $derived(
    normalizedQuery
      ? stacks.filter((stack) => stack.name.toLowerCase().includes(normalizedQuery))
      : stacks,
  );

  function formatItemCount(count: number): string {
    return count === 1 ? "1 item" : `${count} items`;
  }

  async function createStack(): Promise<void> {
    const name = newStackName.trim();
    if (!name) return;
    await api.createStack(name);
    newStackName = "";
    await onStacksChanged();
  }

  async function startRename(stack: StackWithCount): Promise<void> {
    renamingStackId = stack.id;
    renameValue = stack.name;
    await tick();
    renameInputEl?.focus();
    renameInputEl?.select();
  }

  async function confirmRename(stackId: number): Promise<void> {
    const newName = renameValue.trim();
    if (!newName) return;
    await api.renameStack(stackId, newName);
    renamingStackId = null;
    await onStacksChanged();
  }
</script>

<div id="stack-manage" class="stack-manage" hidden={!open}>
  <div id="stack-manage-list">
    {#if visibleStacks.length === 0}
      <p class="stack-manage__empty">No matching lists.</p>
    {:else}
      {#each visibleStacks as stack (stack.id)}
        <div class="stack-manage__item" data-manage-stack-id={stack.id}>
          {#if renamingStackId === stack.id}
            <input
              type="text"
              class="stack-manage__rename-input input"
              bind:value={renameValue}
              bind:this={renameInputEl}
            />
            <button class="stack-manage__rename-confirm" onclick={() => confirmRename(stack.id)}
              >Save</button
            >
          {:else}
            <span class="stack-manage__name">{stack.name}</span>
            <span class="stack-manage__count">{formatItemCount(stack.item_count)}</span>
            {#if stack.parent_stack_ids.length > 0}
              <span class="stack-manage__parent-chip" title="Has parent list">nested</span>
            {/if}
            <button class="stack-manage__rename-btn" onclick={() => startRename(stack)}
              >Rename</button
            >
            <button class="stack-manage__delete-btn" onclick={() => onDeleteStack(stack.id)}
              >Delete</button
            >
          {/if}
        </div>
      {/each}
    {/if}
  </div>
  <div class="stack-manage__create">
    <input
      type="text"
      id="stack-manage-input"
      class="input"
      placeholder="New stack name..."
      bind:value={newStackName}
    />
    <button type="button" id="stack-manage-create-btn" class="btn btn--primary" onclick={createStack}>
      Create
    </button>
  </div>
</div>

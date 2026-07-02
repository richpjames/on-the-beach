<script lang="ts">
  import Case from "case";
  import { tick } from "svelte";
  import type { ListenStatus, MusicItemFull, StackWithCount } from "../../types";
  import { STATUS_LABELS } from "../../ui/domain/status";
  import { api } from "../api";
  import { registerOpenPopover, unregisterPopover } from "../popover-registry";
  import { flipPopoverUpIfClipped } from "../popover";
  import StackDropdown from "./StackDropdown.svelte";
  import StarRating from "./StarRating.svelte";

  let {
    item,
    onStatusChanged,
    onDelete,
    onStacksChanged,
    onStackDropdownClosed,
  }: {
    item: MusicItemFull;
    onStatusChanged: (itemId: number, status: ListenStatus) => Promise<void>;
    onDelete: (itemId: number) => Promise<void>;
    /** A stack was created or the item's stack memberships changed. */
    onStacksChanged: () => Promise<void> | void;
    /** The stack dropdown closed — refresh the list to show new chips. */
    onStackDropdownClosed: () => void;
  } = $props();

  const releaseHref = $derived(`/r/${item.id}`);

  // ── Action menu ────────────────────────────────────────────────────────────
  let menuOpen = $state(false);
  let menuPanelEl: HTMLElement | undefined = $state();

  const closeMenu = (): void => {
    if (!menuOpen) return;
    menuOpen = false;
    unregisterPopover(closeMenu);
    document.removeEventListener("keydown", onMenuEscape);
    document.removeEventListener("click", onMenuOutsideClick);
  };

  const onMenuEscape = (event: KeyboardEvent): void => {
    if (event.key === "Escape") closeMenu();
  };

  const onMenuOutsideClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (menuPanelEl?.contains(target)) return;
    closeMenu();
  };

  async function toggleMenu(): Promise<void> {
    if (menuOpen) {
      closeMenu();
      return;
    }
    menuOpen = true;
    registerOpenPopover(closeMenu);
    document.addEventListener("keydown", onMenuEscape);
    setTimeout(() => {
      if (menuOpen) document.addEventListener("click", onMenuOutsideClick);
    }, 0);
    await tick();
    if (menuPanelEl) {
      menuPanelEl.style.top = "";
      menuPanelEl.style.bottom = "";
      flipPopoverUpIfClipped(menuPanelEl);
    }
  }

  // ── Stack dropdown ────────────────────────────────────────────────────────
  let actionsEl: HTMLElement | undefined = $state();
  let stackBtnEl: HTMLElement | undefined = $state();
  let dropdownOpen = $state(false);
  let dropdownStacks = $state<StackWithCount[]>([]);
  let dropdownSelected = $state<Set<number>>(new Set());
  let dropdownAnchorTop = $state<number | undefined>(undefined);

  const closeDropdown = (): void => {
    if (!dropdownOpen) return;
    dropdownOpen = false;
    unregisterPopover(closeDropdown);
    onStackDropdownClosed();
  };

  async function openStackDropdown(): Promise<void> {
    closeMenu();
    const [allStacks, itemStacks] = await Promise.all([
      api.listStacks(),
      api.getStacksForItem(item.id),
    ]);
    dropdownStacks = allStacks;
    dropdownSelected = new Set(itemStacks.map((stack) => stack.id));
    dropdownAnchorTop = stackBtnEl ? stackBtnEl.offsetTop + stackBtnEl.offsetHeight : undefined;
    dropdownOpen = true;
    registerOpenPopover(closeDropdown);
  }

  async function onDropdownToggle(stackId: number, checked: boolean): Promise<void> {
    if (checked) {
      await api.addItemToStack(item.id, stackId);
      dropdownSelected = new Set([...dropdownSelected, stackId]);
    } else {
      await api.removeItemFromStack(item.id, stackId);
      const next = new Set(dropdownSelected);
      next.delete(stackId);
      dropdownSelected = next;
    }
    await onStacksChanged();
  }

  async function onDropdownCreate(name: string): Promise<void> {
    const stack = await api.createStack(name);
    await api.addItemToStack(item.id, stack.id);
    dropdownStacks = await api.listStacks();
    dropdownSelected = new Set([...dropdownSelected, stack.id]);
    await onStacksChanged();
  }

  // ── Item actions ──────────────────────────────────────────────────────────
  async function onStatusSelect(event: Event): Promise<void> {
    const select = event.currentTarget as HTMLSelectElement;
    await onStatusChanged(item.id, select.value as ListenStatus);
  }

  async function handleDelete(): Promise<void> {
    if (!confirm("Delete this item?")) return;
    closeMenu();
    await onDelete(item.id);
  }
</script>

<article
  class="music-card{item.artwork_url ? '' : ' music-card--no-artwork'}"
  data-item-id={item.id}
>
  <a href={releaseHref}>
    {#if item.artwork_url}
      <img
        class="music-card__artwork music-card__artwork--link"
        src={item.artwork_url}
        alt="Artwork for {item.title}"
      />
    {:else}
      <img
        class="music-card__artwork music-card__artwork--placeholder"
        src="/favicon-32x32.png"
        alt="No artwork available"
      />
    {/if}
  </a>
  <div class="music-card__content">
    <a href={releaseHref} class="music-card__link">
      <div class="music-card__title">{item.title}</div>
      {#if item.artist_name}
        <div class="music-card__artist">{item.artist_name}</div>
      {/if}
      {#if item.stacks.length > 0}
        <div class="music-card__stacks">
          {#each item.stacks as stack (stack.id)}
            <span class="music-card__stack-chip">{stack.name}</span>
          {/each}
        </div>
      {/if}
    </a>
    <div class="music-card__meta">
      <select class="status-select" onchange={onStatusSelect}>
        {#each Object.entries(STATUS_LABELS) as [value, label] (value)}
          <option {value} selected={item.listen_status === value}>{label}</option>
        {/each}
      </select>
      <StarRating
        itemId={item.id}
        rating={item.rating}
        onRate={async (next) => {
          await api.updateMusicItem(item.id, { rating: next });
        }}
      />
      {#if item.primary_source}
        {#if item.primary_url}
          <a
            href={item.primary_url}
            target="_blank"
            rel="noopener noreferrer"
            class="badge badge--source">{Case.title(item.primary_source)}</a
          >
        {:else}
          <span class="badge badge--source">{Case.title(item.primary_source)}</span>
        {/if}
      {/if}
    </div>
  </div>
  <div
    class="music-card__actions"
    bind:this={actionsEl}
    style:position={dropdownOpen ? "relative" : undefined}
  >
    <button
      type="button"
      class="btn btn--ghost music-card__reorder-handle"
      title="Reorder {item.title}"
      aria-label="Reorder {item.title}"
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
        <rect x="2" y="2" width="2" height="2"></rect>
        <rect x="2" y="6" width="2" height="2"></rect>
        <rect x="2" y="10" width="2" height="2"></rect>
        <rect x="8" y="2" width="2" height="2"></rect>
        <rect x="8" y="6" width="2" height="2"></rect>
        <rect x="8" y="10" width="2" height="2"></rect>
      </svg>
    </button>
    {#if item.primary_url}
      <a
        href={item.primary_url}
        target="_blank"
        rel="noopener noreferrer"
        class="btn btn--ghost music-card__action-btn"
        title="Open link"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
          <polyline points="15 3 21 3 21 9"></polyline>
          <line x1="10" y1="14" x2="21" y2="3"></line>
        </svg>
      </a>
    {/if}
    <button
      type="button"
      class="btn btn--ghost music-card__action-btn"
      data-action="stack"
      title="Manage stacks"
      bind:this={stackBtnEl}
      onclick={openStackDropdown}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <line x1="12" y1="5" x2="12" y2="19"></line>
        <line x1="5" y1="12" x2="19" y2="12"></line>
      </svg>
    </button>
    <a href={releaseHref} class="btn btn--ghost music-card__action-btn" title="View release page">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
      </svg>
    </a>
    <button
      type="button"
      class="btn btn--ghost btn--danger music-card__action-btn"
      data-action="delete"
      title="Delete"
      onclick={handleDelete}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
        ></path>
      </svg>
    </button>
    <button
      type="button"
      class="btn btn--ghost music-card__menu-toggle"
      data-action="toggle-item-menu"
      title="More actions"
      aria-haspopup="true"
      aria-expanded={menuOpen ? "true" : "false"}
      onclick={toggleMenu}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="12" cy="5" r="1.8"></circle>
        <circle cx="12" cy="12" r="1.8"></circle>
        <circle cx="12" cy="19" r="1.8"></circle>
      </svg>
    </button>
    <div class="music-card__menu-panel" hidden={!menuOpen} bind:this={menuPanelEl}>
      {#if item.primary_url}
        <a
          href={item.primary_url}
          target="_blank"
          rel="noopener noreferrer"
          class="music-card__menu-item"
          onclick={closeMenu}>Open link</a
        >
      {/if}
      <button type="button" class="music-card__menu-item" data-action="stack-menu" onclick={openStackDropdown}>
        Manage stacks
      </button>
      <a href={releaseHref} class="music-card__menu-item" onclick={closeMenu}>View release page</a>
      <button
        type="button"
        class="music-card__menu-item music-card__menu-item--danger"
        data-action="delete-menu"
        onclick={handleDelete}
      >
        Delete
      </button>
    </div>
    {#if dropdownOpen}
      <StackDropdown
        stacks={dropdownStacks}
        selectedStackIds={dropdownSelected}
        onToggle={onDropdownToggle}
        onCreate={onDropdownCreate}
        onClose={closeDropdown}
        anchorTop={dropdownAnchorTop}
        flipUpIfClipped
      />
    {/if}
  </div>
</article>

<script lang="ts">
  let {
    child,
    onOpen,
    onRemove,
  }: {
    child: { id: number; name: string; item_count: number };
    onOpen: (stackId: number) => void;
    onRemove: (stackId: number) => Promise<void>;
  } = $props();

  function formatItemCount(count: number): string {
    return count === 1 ? "1 item" : `${count} items`;
  }

  function onRowClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).closest("button")) return;
    onOpen(child.id);
  }
</script>

<article
  class="folder-row"
  data-child-stack-id={child.id}
  onclick={onRowClick}
  role="presentation"
>
  <div class="folder-row__icon">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"
      />
    </svg>
  </div>
  <div class="folder-row__content">
    <span class="folder-row__name">{child.name}</span>
    <span class="folder-row__count">({formatItemCount(child.item_count)})</span>
  </div>
  <div class="folder-row__actions">
    <button
      type="button"
      class="btn btn--ghost folder-row__reorder-handle"
      title="Reorder"
      aria-label="Reorder {child.name}"
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
    <button
      type="button"
      class="btn btn--ghost btn--danger folder-row__remove-btn"
      data-remove-child-stack={child.id}
      title="Remove from this list"
      onclick={() => onRemove(child.id)}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    </button>
  </div>
</article>

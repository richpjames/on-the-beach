<script lang="ts">
  import { tick } from "svelte";
  import type { MusicItemFull } from "../../../domain/types";
  import type { addFormMachine } from "../../ui/state/add-form-machine";
  import type { MachineHandle } from "../use-machine.svelte";
  import VerticalScrollbar from "./VerticalScrollbar.svelte";

  let { form }: { form: MachineHandle<typeof addFormMachine> } = $props();

  const warning = $derived(
    form.snapshot.matches("duplicateOpen") ? form.snapshot.context.duplicateWarning : null,
  );
  const items = $derived(warning?.items ?? []);

  let listEl: HTMLElement | undefined = $state();
  let cancelEl: HTMLButtonElement | undefined = $state();

  // The safe answer gets focus, so a reflexive Enter doesn't add a second copy.
  $effect(() => {
    if (!warning) return;
    void tick().then(() => cancelEl?.focus());
  });

  $effect(() => {
    if (!warning) return;
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") form.send({ type: "DUPLICATE_CANCELLED" });
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  });

  function formatAddedAt(item: MusicItemFull): string {
    const date = new Date(item.created_at);
    return Number.isNaN(date.getTime()) ? "" : `Added ${date.toLocaleDateString()}`;
  }

  function formatListenStatus(item: MusicItemFull): string {
    return item.listen_status === "listened" ? "Listened" : "To listen";
  }
</script>

<div id="duplicate-warning-modal" class="link-picker" hidden={!warning}>
  <div
    class="link-picker__backdrop"
    data-duplicate-close="true"
    onclick={() => form.send({ type: "DUPLICATE_CANCELLED" })}
    role="presentation"
  ></div>
  <div
    class="link-picker__dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="duplicate-warning-title"
    aria-describedby="duplicate-warning-message"
  >
    <div class="link-picker__header">
      <h2 id="duplicate-warning-title">Already in your list</h2>
      <p id="duplicate-warning-message">
        {warning?.message ?? "This looks like something already in your list."}
      </p>
    </div>
    <div class="link-picker__list-shell duplicate-warning__list-shell">
      <div id="duplicate-warning-list" class="link-picker__list" bind:this={listEl}>
        {#each items as item (item.id)}
          <div class="duplicate-warning__item" data-duplicate-item-id={item.id}>
            {#if item.artwork_url}
              <img
                class="duplicate-warning__artwork"
                src={item.artwork_url}
                alt=""
                loading="lazy"
              />
            {/if}
            <div class="duplicate-warning__details">
              <span class="duplicate-warning__title">{item.title}</span>
              {#if item.artist_name}
                <span class="duplicate-warning__artist">{item.artist_name}</span>
              {/if}
              <span class="duplicate-warning__meta">
                {#if item.year}
                  <span>{item.year}</span>
                {/if}
                <span class="badge badge--source">{formatListenStatus(item)}</span>
                {#if formatAddedAt(item)}
                  <span class="duplicate-warning__added">{formatAddedAt(item)}</span>
                {/if}
              </span>
            </div>
          </div>
        {/each}
      </div>
      <VerticalScrollbar
        target={listEl}
        id="duplicate-warning-scrollbar"
        trackId="duplicate-warning-scroll-track"
        thumbId="duplicate-warning-scroll-thumb"
        buttonAttr="data-duplicate-warning-scroll-btn"
        syncKey={items.map((item) => item.id).join(",")}
      />
    </div>
    <div class="link-picker__actions">
      <button
        type="button"
        id="duplicate-warning-cancel"
        class="btn btn--ghost"
        bind:this={cancelEl}
        onclick={() => form.send({ type: "DUPLICATE_CANCELLED" })}>Cancel</button
      >
      <button
        type="button"
        id="duplicate-warning-add-anyway"
        class="btn btn--primary"
        onclick={() => form.send({ type: "ADD_ANYWAY_CLICKED" })}
      >
        Add anyway
      </button>
    </div>
  </div>
</div>

<script lang="ts">
  import type { LinkReleaseCandidate } from "../../types";
  import type { addFormMachine } from "../../ui/state/add-form-machine";
  import type { MachineHandle } from "../use-machine.svelte";
  import VerticalScrollbar from "./VerticalScrollbar.svelte";

  let {
    form,
    onEnterManually,
  }: {
    form: MachineHandle<typeof addFormMachine>;
    onEnterManually: (candidate: LinkReleaseCandidate | undefined) => void;
  } = $props();

  const linkPicker = $derived(
    form.snapshot.matches("linkPickerOpen") ? form.snapshot.context.linkPicker : null,
  );

  let listEl: HTMLElement | undefined = $state();

  // Reset scroll whenever the picker (re)opens with new candidates.
  $effect(() => {
    void linkPicker;
    if (listEl) listEl.scrollTop = 0;
  });

  $effect(() => {
    if (!linkPicker) return;
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") form.send({ type: "LINK_PICKER_CANCELLED" });
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  });

  function enterManually(): void {
    const firstId = linkPicker?.selectedCandidateIds[0];
    const candidate = firstId
      ? linkPicker?.candidates.find((c) => c.candidateId === firstId)
      : undefined;
    onEnterManually(candidate);
    form.send({ type: "ENTER_MANUALLY" });
  }
</script>

<div id="link-picker-modal" class="link-picker" hidden={!linkPicker}>
  <div
    class="link-picker__backdrop"
    data-link-picker-close="true"
    onclick={() => form.send({ type: "LINK_PICKER_CANCELLED" })}
    role="presentation"
  ></div>
  <div
    class="link-picker__dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="link-picker-title"
  >
    <div class="link-picker__header">
      <h2 id="link-picker-title">Pick releases</h2>
      <p id="link-picker-message">
        {linkPicker?.message ?? "This link mentions several releases. Pick one or more to add."}
      </p>
      <p id="link-picker-url" class="link-picker__url">{linkPicker?.url ?? ""}</p>
    </div>
    <div class="link-picker__list-header">
      <button
        type="button"
        id="link-picker-select-all"
        class="btn btn--ghost"
        onclick={() => form.send({ type: "ALL_CANDIDATES_SELECTED" })}>Select all</button
      >
    </div>
    <div class="link-picker__list-shell">
      <div id="link-picker-list" class="link-picker__list" bind:this={listEl}>
        {#each linkPicker?.candidates ?? [] as candidate (candidate.candidateId)}
          {@const isSelected = linkPicker?.selectedCandidateIds.includes(candidate.candidateId)}
          <button
            type="button"
            class="link-picker__candidate"
            class:is-selected={isSelected}
            data-candidate-id={candidate.candidateId}
            aria-pressed={isSelected ? "true" : "false"}
            onclick={() =>
              form.send({ type: "CANDIDATE_TOGGLED", candidateId: candidate.candidateId })}
          >
            <span class="link-picker__candidate-main">
              <span class="link-picker__candidate-title">{candidate.title}</span>
              {#if candidate.artist}
                <span class="link-picker__candidate-artist">{candidate.artist}</span>
              {/if}
            </span>
            <span class="link-picker__candidate-meta">
              {#if candidate.itemType}
                <span class="badge badge--source">{candidate.itemType}</span>
              {/if}
              {#if candidate.isPrimary}
                <span class="badge badge--source">primary</span>
              {/if}
            </span>
            {#if candidate.evidence}
              <span class="link-picker__candidate-evidence">{candidate.evidence}</span>
            {/if}
          </button>
        {/each}
      </div>
      <VerticalScrollbar
        target={listEl}
        id="link-picker-scrollbar"
        trackId="link-picker-scroll-track"
        thumbId="link-picker-scroll-thumb"
        buttonAttr="data-link-picker-scroll-btn"
        syncKey={linkPicker}
      />
    </div>
    <div class="link-picker__actions">
      <button
        type="button"
        id="link-picker-cancel"
        class="btn btn--ghost"
        onclick={() => form.send({ type: "LINK_PICKER_CANCELLED" })}>Cancel</button
      >
      <button type="button" id="link-picker-manual" class="btn btn--ghost" onclick={enterManually}>
        Enter manually
      </button>
      <button
        type="button"
        id="link-picker-submit"
        class="btn btn--primary"
        disabled={(linkPicker?.selectedCandidateIds.length ?? 0) === 0}
        onclick={() => form.send({ type: "CANDIDATE_SUBMITTED" })}
      >
        Add selected
      </button>
    </div>
  </div>
</div>

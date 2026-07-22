<script lang="ts">
  import { tick } from "svelte";
  import type { StackWithCount } from "../../types";
  import type { AddFormValues } from "../../ui/domain/add-form";
  import { getCoverScanErrorMessage, toListSearchQuery } from "../../ui/domain/add-form";
  import { addFormMachine, RECORD_DURATION_MS } from "../../ui/state/add-form-machine";
  import { api } from "../api";
  import { encodeImageFile } from "../encode-image";
  import type { MachineHandle } from "../use-machine.svelte";
  import StackDropdown from "./StackDropdown.svelte";

  let {
    form,
    stacks,
    appReady,
    onStackCreated,
    onItemCreated,
    onSearch,
  }: {
    form: MachineHandle<typeof addFormMachine>;
    stacks: StackWithCount[];
    appReady: boolean;
    /** A stack was created from the picker — refresh the app's stack list. */
    onStackCreated: () => Promise<void>;
    /** An item was created — refresh the list and stack bar. */
    onItemCreated: () => void;
    /** The add bar doubles as a search box — live-filter the list as the user types. */
    onSearch: (query: string) => void;
  } = $props();

  const ctx = $derived(form.snapshot.context);

  // ── Field state ────────────────────────────────────────────────────────────
  let url = $state("");
  let artist = $state("");
  let title = $state("");
  let itemType = $state("album");
  let label = $state("");
  // Svelte binds type="number" inputs as numbers; empty renders as "".
  let year = $state<string | number>("");
  let country = $state("");
  let genre = $state("");
  let artworkUrl = $state("");
  let catalogueNumber = $state("");
  let notes = $state("");
  let detailsOpen = $state(false);

  let scanInputEl: HTMLInputElement | undefined = $state();
  let artistInputEl: HTMLInputElement | undefined = $state();

  export function populateFromCandidate(candidate: {
    artist?: string;
    title: string;
    itemType?: string;
  }): void {
    if (candidate.artist) artist = candidate.artist;
    title = candidate.title;
    if (candidate.itemType) itemType = candidate.itemType;
    // Focus once the secondary fields are visible.
    tick().then(() => artistInputEl?.focus());
  }

  function readValues(): AddFormValues {
    return {
      url,
      title,
      artist,
      itemType: itemType || "album",
      label,
      // The year input is type="number", so Svelte binds it as a number;
      // AddFormValues carries form values as strings (like FormData did).
      year: year == null ? "" : String(year),
      country,
      genre,
      catalogueNumber,
      notes,
      artworkUrl,
    };
  }

  // Track what we last pushed so clearing the form only resets the list
  // filter when the add bar itself set it (not a query typed in the browse
  // search panel).
  let lastSearchQuery = "";
  function syncSearch(): void {
    const query = toListSearchQuery(url);
    if (query === lastSearchQuery) return;
    lastSearchQuery = query;
    onSearch(query);
  }

  function resetFields(): void {
    url = "";
    syncSearch();
    artist = "";
    title = "";
    itemType = "album";
    label = "";
    year = "";
    country = "";
    genre = "";
    artworkUrl = "";
    catalogueNumber = "";
    notes = "";
    detailsOpen = false;
  }

  function onSubmit(event: SubmitEvent): void {
    event.preventDefault();
    if (!appReady) {
      alert("App is still loading. Please try again in a moment.");
      return;
    }
    form.send({ type: "SUBMIT_CLICKED", url: url.trim(), pendingValues: readValues() });
  }

  // ── Cover scan ─────────────────────────────────────────────────────────────
  function onScanButtonClick(): void {
    if (ctx.scanState === "scanning") return;
    scanInputEl?.click();
  }

  async function onScanFileChange(): Promise<void> {
    const file = scanInputEl?.files?.[0];
    if (!file || !scanInputEl) return;
    const imageBase64 = await encodeImageFile(file);
    form.send({ type: "SCAN_FILE_SELECTED", imageBase64 });
    scanInputEl.value = "";
  }

  // ── Recognize ("Listen") ───────────────────────────────────────────────────
  function onRecognizeClick(): void {
    if (ctx.recognizeState === "recording") {
      form.send({ type: "STOP_RECORDING" });
    } else {
      form.send({ type: "RECOGNIZE_CLICKED" });
    }
  }

  let secondsLeft = $state(0);
  $effect(() => {
    if (ctx.recognizeState !== "recording") return;
    secondsLeft = Math.round(RECORD_DURATION_MS / 1000);
    const interval = setInterval(() => {
      if (secondsLeft > 1) secondsLeft -= 1;
    }, 1000);
    return () => clearInterval(interval);
  });

  // ── Machine result/error effects ───────────────────────────────────────────
  $effect(() => {
    const result = ctx.scanResult;
    if (!result) return;
    if (result.artist) artist = result.artist;
    if (result.title) title = result.title;
    if (result.artworkUrl) artworkUrl = result.artworkUrl;
    if (result.artist || result.title) detailsOpen = true;
    form.send({ type: "SCAN_RESULT_CONSUMED" });
  });

  $effect(() => {
    if (!ctx.scanError) return;
    alert(getCoverScanErrorMessage(new Error(ctx.scanError)));
    form.send({ type: "SCAN_RESULT_CONSUMED" });
  });

  $effect(() => {
    if (!ctx.recognizeError) return;
    alert(ctx.recognizeError);
    form.send({ type: "RECOGNIZE_ERROR_CONSUMED" });
  });

  // On successful create the page machine refreshes the list; the form resets.
  $effect(() => {
    if (ctx.createdItemId == null) return;
    resetFields();
    onItemCreated();
    form.send({ type: "CLEAR_CREATED_ITEM" });
  });

  // ── Stack picker ───────────────────────────────────────────────────────────
  let stackDropdownOpen = $state(false);
  let pickerEl: HTMLElement | undefined = $state();

  const selectedStacks = $derived(
    ctx.selectedStackIds
      .map((stackId) => stacks.find((candidate) => candidate.id === stackId))
      .filter((stack): stack is StackWithCount => stack !== undefined),
  );

  function openStackDropdown(): void {
    stackDropdownOpen = true;
    // The picker sits in page flow near the bottom of the expanded form, so on
    // small screens the dropdown can open past the fold; the page scrolls, so
    // just bring it into view.
    requestAnimationFrame(() => {
      pickerEl?.querySelector(".stack-dropdown")?.scrollIntoView({ block: "nearest" });
    });
  }

  async function onStackDropdownCreate(name: string): Promise<void> {
    const stack = await api.createStack(name);
    form.send({ type: "STACK_ADDED", stackId: stack.id });
    await onStackCreated();
  }
</script>

<section class="add-section">
  <form id="add-form" class="add-form" method="post" onsubmit={onSubmit}>
    <div class="add-form__primary">
      <input
        type="text"
        id="url-input"
        name="url"
        placeholder="search or paste a link"
        class="input"
        bind:value={url}
        oninput={syncSearch}
      />
      <input
        type="file"
        id="scan-file-input"
        class="add-form__scan-input"
        accept="image/*"
        bind:this={scanInputEl}
        onchange={onScanFileChange}
      />
      <button
        type="button"
        id="add-form-scan-btn"
        class="btn add-form__scan-btn"
        aria-label="Scan release cover"
        disabled={ctx.scanState === "scanning"}
        onclick={onScanButtonClick}
      >
        Photo
      </button>
      <button
        type="button"
        id="add-form-recognize-btn"
        class="btn add-form__recognize-btn"
        class:is-recording={ctx.recognizeState === "recording"}
        class:is-recognizing={ctx.recognizeState === "recognizing"}
        aria-label="Identify playing song"
        disabled={ctx.submitState === "submitting"}
        onclick={onRecognizeClick}
      >
        {ctx.recognizeState === "recording" ? `${secondsLeft}s` : "Listen"}
      </button>
      <button
        type="submit"
        id="add-form-submit"
        class="btn btn--primary"
        disabled={ctx.submitState === "submitting"}
      >
        {ctx.submitState === "submitting" ? "Adding..." : "Add"}
      </button>
    </div>

    <div class="add-form__secondary" hidden={!ctx.showSecondaryFields}>
      <input type="text" name="artist" placeholder="Artist" class="input" bind:value={artist} bind:this={artistInputEl} />
      <input type="text" name="title" placeholder="Release" class="input" bind:value={title} />
      <select name="itemType" class="input" bind:value={itemType}>
        <option value="album">Release</option>
        <option value="ep">EP</option>
        <option value="single">Single</option>
        <option value="track">Track</option>
        <option value="mix">Mix</option>
      </select>

      <details class="add-form__details" bind:open={detailsOpen}>
        <summary>Add more details</summary>
        <div class="add-form__extra">
          <input type="text" name="label" placeholder="Label" class="input" bind:value={label} />
          <input
            type="number"
            name="year"
            placeholder="Year"
            min="1900"
            max="2099"
            class="input"
            bind:value={year}
          />
          <input type="text" name="country" placeholder="Country" class="input" bind:value={country} />
          <input type="text" name="genre" placeholder="Genre" class="input" bind:value={genre} />
          <input
            type="text"
            name="artworkUrl"
            placeholder="Artwork URL"
            class="input"
            bind:value={artworkUrl}
          />
          <input
            type="text"
            name="catalogueNumber"
            placeholder="Catalogue number"
            class="input"
            bind:value={catalogueNumber}
          />
          <textarea name="notes" placeholder="Notes" class="input" bind:value={notes}></textarea>
          <div class="stack-picker" id="add-form-stacks" bind:this={pickerEl}>
            <div class="stack-picker__chips" id="add-form-stack-chips">
              {#each selectedStacks as stack (stack.id)}
                <span class="stack-chip">
                  {stack.name}
                  <button
                    type="button"
                    class="stack-chip__remove"
                    data-remove-stack={stack.id}
                    onclick={() => form.send({ type: "STACK_REMOVED", stackId: stack.id })}
                    >&times;</button
                  >
                </span>
              {/each}
            </div>
            <button
              type="button"
              class="stack-picker__add btn btn--ghost"
              id="add-form-stack-btn"
              onclick={openStackDropdown}
            >
              + Stack
            </button>
            {#if stackDropdownOpen}
              <StackDropdown
                {stacks}
                selectedStackIds={new Set(ctx.selectedStackIds)}
                onToggle={(stackId, checked) =>
                  form.send({ type: "STACK_TOGGLED", stackId, checked })}
                onCreate={onStackDropdownCreate}
                onClose={() => (stackDropdownOpen = false)}
                shouldIgnoreOutsideClick={(target) =>
                  target.closest("#add-form-stack-btn") !== null}
              />
            {/if}
          </div>
        </div>
      </details>
    </div>
  </form>
</section>

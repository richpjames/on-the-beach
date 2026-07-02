<script lang="ts">
  import { tick } from "svelte";
  import type { StackWithCount } from "../../types";
  import type { AddFormValues } from "../../ui/domain/add-form";
  import { getCoverScanErrorMessage } from "../../ui/domain/add-form";
  import { constrainDimensions } from "../../ui/domain/scan";
  import { addFormMachine, RECORD_DURATION_MS } from "../../ui/state/add-form-machine";
  import { api } from "../api";
  import type { MachineHandle } from "../use-machine.svelte";
  import StackDropdown from "./StackDropdown.svelte";

  let {
    form,
    stacks,
    appReady,
    onStackCreated,
    onItemCreated,
  }: {
    form: MachineHandle<typeof addFormMachine>;
    stacks: StackWithCount[];
    appReady: boolean;
    /** A stack was created from the picker — refresh the app's stack list. */
    onStackCreated: () => Promise<void>;
    /** An item was created — refresh the list and stack bar. */
    onItemCreated: () => void;
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

  function resetFields(): void {
    url = "";
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
    const imageBase64 = await encodeScanImage(file);
    form.send({ type: "SCAN_FILE_SELECTED", imageBase64 });
    scanInputEl.value = "";
  }

  async function encodeScanImage(file: File): Promise<string> {
    const imageDataUrl = await readFileAsDataUrl(file);
    const image = await loadImage(imageDataUrl);
    const { width, height } = constrainDimensions(image.width, image.height, 1024);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas context unavailable");
    }

    context.drawImage(image, 0, 0, width, height);
    const encoded = canvas.toDataURL("image/jpeg", 0.85);
    const parts = encoded.split(",", 2);
    if (parts.length !== 2 || !parts[1]) {
      throw new Error("Failed to encode scan image");
    }

    return parts[1];
  }

  function readFileAsDataUrl(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result !== "string") {
          reject(new Error("Failed to read image file"));
          return;
        }
        resolve(reader.result);
      };
      reader.onerror = () => {
        reject(reader.error ?? new Error("Failed to read image file"));
      };
      reader.readAsDataURL(file);
    });
  }

  function loadImage(dataUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Failed to load image"));
      image.src = dataUrl;
    });
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

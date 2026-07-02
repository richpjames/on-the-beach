<script lang="ts">
  import type { addFormMachine } from "../../ui/state/add-form-machine";
  import type { MachineHandle } from "../use-machine.svelte";

  let { form }: { form: MachineHandle<typeof addFormMachine> } = $props();

  const ctx = $derived(form.snapshot.context);
  const visible = $derived(
    ctx.submitState === "submitting" ||
      ctx.scanState === "scanning" ||
      ctx.recognizeState === "recognizing",
  );
  const status = $derived(
    ctx.scanState === "scanning"
      ? "Scanning cover..."
      : ctx.recognizeState === "recognizing"
        ? "Identifying song..."
        : "Adding to collection...",
  );
</script>

<div
  id="add-loading-overlay"
  class="add-loading-overlay"
  class:is-visible={visible}
  aria-hidden={visible ? "false" : "true"}
>
  <div
    class="add-loading-dialog"
    role="alertdialog"
    aria-labelledby="add-loading-title"
    aria-describedby="add-loading-status"
  >
    <div class="add-loading-dialog__titlebar">
      <span class="add-loading-dialog__titlebar-icon" aria-hidden="true">💿</span>
      <span class="add-loading-dialog__title" id="add-loading-title">On The Beach</span>
      <div class="add-loading-dialog__winbtns" aria-hidden="true">
        <button class="add-loading-dialog__winbtn" tabindex="-1" disabled>_</button>
        <button class="add-loading-dialog__winbtn" tabindex="-1" disabled>□</button>
        <button
          class="add-loading-dialog__winbtn add-loading-dialog__winbtn--close"
          tabindex="-1"
          disabled
        >
          ✕
        </button>
      </div>
    </div>
    <div class="add-loading-dialog__body">
      <div class="add-loading-dialog__content">
        <p class="add-loading-dialog__status" id="add-loading-status">
          {status}
        </p>
        <div
          class="add-loading-dialog__progress"
          role="progressbar"
          aria-label="Adding release"
          aria-busy="true"
        >
          <div class="add-loading-dialog__progress-fill"></div>
        </div>
        <p class="add-loading-dialog__substatus" aria-hidden="true">Please wait...</p>
      </div>
    </div>
    <div class="add-loading-dialog__footer">
      <button class="btn" disabled>Cancel</button>
    </div>
  </div>
</div>

<script lang="ts">
  import { onMount } from "svelte";
  import { player } from "../player.svelte";
  import { canAutoAdvance } from "../../ui/state/player-machine";

  // The queue window is desktop-only, exactly like "listen here": on touch
  // devices the floating window chrome doesn't suit the screen. Set after mount
  // (not at init) to keep SSR and hydration in sync.
  let coarsePointer = $state(false);
  onMount(() => {
    coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  });

  let windowEl: HTMLElement | undefined = $state();

  // Titlebar drag, replicated from PlayerWindow so both windows move the same
  // way. (The queue titlebar's text isn't a link, so there is no drag-vs-click
  // swallow to do here.)
  function onTitlebarMousedown(e: MouseEvent): void {
    if ((e.target as Element).closest("button") || !windowEl) return;
    const el = windowEl;
    const startX = e.clientX;
    const startY = e.clientY;
    const rect = el.getBoundingClientRect();
    const startLeft = rect.left;
    const startTop = rect.top;
    e.preventDefault();

    const onMove = (ev: MouseEvent): void => {
      el.style.left = `${startLeft + (ev.clientX - startX)}px`;
      el.style.top = `${startTop + (ev.clientY - startY)}px`;
      el.style.bottom = "auto";
      el.style.right = "auto";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener(
      "mouseup",
      () => {
        document.removeEventListener("mousemove", onMove);
      },
      { once: true },
    );
  }

  const entries = $derived(player.queue);
  const showWindow = $derived(!coarsePointer && player.queueWindowOpen);

  // Clicking a row plays it now (player.playQueueEntry: move to head + ADVANCE,
  // keeping the rest in order). Clicks on the label link and the row buttons
  // keep their own meaning.
  function onRowClick(e: MouseEvent, index: number): void {
    if ((e.target as Element).closest("a, button")) return;
    player.playQueueEntry(index);
  }

  function hide(): void {
    // Minimize and close do the same thing here: the window has no taskbar
    // restore state of its own beyond the toggle, and closing never clears
    // the queue.
    if (windowEl) {
      windowEl.style.removeProperty("left");
      windowEl.style.removeProperty("top");
      windowEl.style.removeProperty("bottom");
      windowEl.style.removeProperty("right");
    }
    player.toggleQueueWindow();
  }
</script>

<div
  id="queue-window"
  class="player-window queue-window"
  bind:this={windowEl}
  hidden={!showWindow}
  aria-hidden={showWindow ? undefined : "true"}
>
  <div class="player-window__titlebar" id="queue-titlebar" onmousedown={onTitlebarMousedown} role="presentation">
    <span class="player-window__icon" aria-hidden="true">▤</span>
    <span class="player-window__title" id="queue-title">
      Queue{entries.length > 0 ? ` (${entries.length})` : ""}
    </span>
    <div class="player-window__winbtns">
      <button
        class="player-window__winbtn"
        id="queue-minimize"
        aria-label="Hide queue"
        title="Hide queue"
        onclick={hide}>_</button
      >
      <button
        class="player-window__winbtn player-window__winbtn--close"
        id="queue-close"
        aria-label="Hide queue"
        title="Close"
        onclick={hide}>✕</button
      >
    </div>
  </div>
  <div class="queue-window__body" id="queue-body">
    {#if player.active}
      <div class="queue-window__now" id="queue-now" title={player.label}>
        <span aria-hidden="true">▶</span>
        <span class="queue-window__now-label">{player.label}</span>
      </div>
    {/if}
    {#if entries.length === 0}
      <div class="queue-window__empty">Nothing queued.</div>
    {:else}
      <ol class="queue-window__list" id="queue-list">
        {#each entries as entry, i (i)}
          <li>
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="queue-window__row" data-qi={entry.itemId} onclick={(e) => onRowClick(e, i)}>
              <button
                class="queue-window__pos"
                type="button"
                aria-label={`Play ${entry.label} now`}
                title="Play now"
                onclick={() => player.playQueueEntry(i)}>{i + 1}</button
              >
              <a class="queue-window__label" href={`/r/${entry.itemId}`} title={entry.label}
                >{entry.label}</a
              >
              {#if !canAutoAdvance(entry.target)}
                <span
                  class="queue-window__manual"
                  aria-hidden="true"
                  title="This source can't auto-advance — press Next when it's done">✋</span
                >
              {/if}
              <span class="queue-window__rowbtns">
                <button
                  class="queue-window__rowbtn"
                  type="button"
                  aria-label={`Move ${entry.label} up`}
                  title="Move up"
                  disabled={i === 0}
                  onclick={() => player.move(i, i - 1)}>▲</button
                >
                <button
                  class="queue-window__rowbtn"
                  type="button"
                  aria-label={`Move ${entry.label} down`}
                  title="Move down"
                  disabled={i === entries.length - 1}
                  onclick={() => player.move(i, i + 1)}>▼</button
                >
                <button
                  class="queue-window__rowbtn queue-window__rowbtn--remove"
                  type="button"
                  aria-label={`Remove ${entry.label} from queue`}
                  title="Remove"
                  onclick={() => player.removeAt(i)}>✕</button
                >
              </span>
            </div>
          </li>
        {/each}
      </ol>
    {/if}
    <div class="queue-window__footer">
      <button
        class="queue-window__footbtn"
        id="queue-next"
        type="button"
        aria-label="Play next in queue"
        title="Play the next queued release"
        disabled={!player.canSkipNext}
        onclick={() => player.skipNext()}>⏭ Next</button
      >
      <button
        class="queue-window__footbtn"
        id="queue-clear"
        type="button"
        aria-label="Clear queue"
        disabled={entries.length === 0}
        onclick={() => player.clearQueue()}>Clear</button
      >
    </div>
  </div>
</div>

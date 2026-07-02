<script lang="ts">
  import { onMount } from "svelte";
  import { player } from "../player.svelte";

  let { showStart = true, showClock = true }: { showStart?: boolean; showClock?: boolean } =
    $props();

  let clock = $state("");

  onMount(() => {
    const tick = (): void => {
      clock = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    };
    tick();
    const interval = setInterval(tick, 10_000);
    return () => clearInterval(interval);
  });
</script>

<div id="taskbar">
  {#if showStart}
    <button id="taskbar-start" class="taskbar__start">🪟 Start</button>
  {/if}
  <button
    id="taskbar-np-btn"
    class="taskbar__task"
    hidden={!player.active}
    data-minimized={player.minimized ? "true" : undefined}
    onclick={() => player.toggleWindow()}
  >
    <span aria-hidden="true">♫</span>
    <span id="taskbar-np-label">{player.active ? player.label : ""}</span>
  </button>
  {#if showClock}
    <span id="taskbar-clock" class="taskbar__clock">{clock}</span>
  {/if}
</div>

<script lang="ts">
  import { onMount } from "svelte";
  import type { MusicItemFull } from "../../types";
  import { api } from "../api";
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

  // ── Scheduled-reminders popup ───────────────────────────────────────────────
  // The taskbar clock is the natural place to look for time-things: clicking it
  // lists the next six scheduled releases, soonest first.
  let popupOpen = $state(false);
  let remindersLoading = $state(false);
  let upcoming = $state<MusicItemFull[]>([]);

  async function toggleClockPopup(): Promise<void> {
    popupOpen = !popupOpen;
    if (!popupOpen) return;

    remindersLoading = true;
    try {
      const result = await api.listMusicItems({ hasReminder: true });
      upcoming = result.items
        .filter((item) => item.remind_at)
        .sort((a, b) => (a.remind_at! < b.remind_at! ? -1 : 1))
        .slice(0, 6);
    } catch {
      upcoming = [];
    } finally {
      remindersLoading = false;
    }
  }

  function reminderDate(item: MusicItemFull): string {
    return new Date(item.remind_at!).toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
  }

  function isDue(item: MusicItemFull): boolean {
    return new Date(item.remind_at!).getTime() <= Date.now();
  }

  function reminderLabel(item: MusicItemFull): string {
    return `${item.artist_name ? `${item.artist_name} — ` : ""}${item.title}`;
  }

  $effect(() => {
    if (!popupOpen) return;

    const onDocumentClick = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const popup = document.getElementById("clock-popup");
      const clockBtn = document.getElementById("taskbar-clock");
      if (popup?.contains(target) || clockBtn?.contains(target)) return;
      popupOpen = false;
    };

    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") popupOpen = false;
    };

    document.addEventListener("keydown", onEscape);
    // Deferred so the click that opened the popup doesn't immediately close it.
    const timer = setTimeout(() => document.addEventListener("click", onDocumentClick), 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", onEscape);
      document.removeEventListener("click", onDocumentClick);
    };
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
    <div id="clock-popup" class="clock-popup" hidden={!popupOpen}>
      <div class="clock-popup__title">📅 Scheduled reminders</div>
      <div id="clock-popup-list" class="clock-popup__list">
        {#if remindersLoading}
          <div class="clock-popup__empty">Loading…</div>
        {:else if upcoming.length === 0}
          <div class="clock-popup__empty">
            No reminders scheduled. Set one from a release page.
          </div>
        {:else}
          {#each upcoming as item (item.id)}
            <a
              class="clock-popup__item"
              class:clock-popup__item--due={isDue(item)}
              href="/r/{item.id}"
              onclick={() => (popupOpen = false)}
            >
              <span class="clock-popup__date">{isDue(item) ? "⏰ " : ""}{reminderDate(item)}</span>
              <span class="clock-popup__label">{reminderLabel(item)}</span>
            </a>
          {/each}
        {/if}
      </div>
    </div>
    <button
      id="taskbar-clock"
      class="taskbar__clock"
      aria-haspopup="true"
      aria-expanded={popupOpen}
      title="Scheduled reminders"
      onclick={toggleClockPopup}>{clock}</button
    >
  {/if}
</div>

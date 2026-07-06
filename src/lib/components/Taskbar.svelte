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

  // ── Start menu ──────────────────────────────────────────────────────────────
  // One canonical, discoverable home for every primary action. The actions
  // drive main-page controls by id — the same contract the e2e specs use.
  let startMenuOpen = $state(false);

  function closeStartMenu(): void {
    startMenuOpen = false;
  }

  function onStartAction(action: string): void {
    closeStartMenu();

    switch (action) {
      case "add": {
        const input = document.getElementById("url-input");
        if (input instanceof HTMLInputElement) {
          input.scrollIntoView({ block: "center" });
          input.focus();
        }
        break;
      }
      case "pick": {
        document.getElementById("pick-random-btn")?.click();
        break;
      }
      case "search": {
        // Defer past the current click event — document-level outside-click
        // handlers would close the panel this opens.
        setTimeout(() => {
          const toggle = document.getElementById("browse-search-toggle");
          const search = document.getElementById("browse-search");
          // On small screens the search input lives behind a toggle; open
          // the panel first, then focus.
          if (toggle instanceof HTMLElement && toggle.offsetParent !== null) {
            if (toggle.getAttribute("aria-expanded") !== "true") {
              toggle.click();
            }
          } else {
            search?.scrollIntoView({ block: "center" });
          }
          if (search instanceof HTMLInputElement) {
            search.focus();
          }
        }, 0);
        break;
      }
      case "stacks": {
        const manageBtn = document.getElementById("manage-stacks-btn");
        const panel = document.getElementById("stack-manage");
        if (manageBtn instanceof HTMLElement && panel instanceof HTMLElement && panel.hidden) {
          manageBtn.click();
        }
        panel?.scrollIntoView({ block: "nearest" });
        break;
      }
    }
  }

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
    if (!startMenuOpen) return;

    const onDocumentClick = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const menu = document.getElementById("start-menu");
      const startBtn = document.getElementById("taskbar-start");
      if (menu?.contains(target) || startBtn?.contains(target)) return;
      closeStartMenu();
    };

    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeStartMenu();
    };

    document.addEventListener("keydown", onEscape);
    // Deferred so the click that opened the menu doesn't immediately close it.
    const timer = setTimeout(() => document.addEventListener("click", onDocumentClick), 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", onEscape);
      document.removeEventListener("click", onDocumentClick);
    };
  });

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
    <div id="start-menu" class="start-menu" hidden={!startMenuOpen}>
      <div class="start-menu__banner" aria-hidden="true">On The Beach</div>
      <div class="start-menu__items" role="menu">
        <button
          type="button"
          class="start-menu__item"
          role="menuitem"
          data-start-action="add"
          onclick={() => onStartAction("add")}
        >
          <span class="start-menu__icon" aria-hidden="true">💿</span>Add a release
        </button>
        <button
          type="button"
          class="start-menu__item"
          role="menuitem"
          data-start-action="pick"
          onclick={() => onStartAction("pick")}
        >
          <span class="start-menu__icon" aria-hidden="true">🎲</span>Pick One
        </button>
        <button
          type="button"
          class="start-menu__item"
          role="menuitem"
          data-start-action="search"
          onclick={() => onStartAction("search")}
        >
          <span class="start-menu__icon" aria-hidden="true">🔍</span>Search
        </button>
        <button
          type="button"
          class="start-menu__item"
          role="menuitem"
          data-start-action="stacks"
          onclick={() => onStartAction("stacks")}
        >
          <span class="start-menu__icon" aria-hidden="true">🗂️</span>Manage stacks
        </button>
        <div class="start-menu__divider" role="separator"></div>
        <a class="start-menu__item" role="menuitem" href="/feed/to-listen.rss" onclick={closeStartMenu}>
          <span class="start-menu__icon" aria-hidden="true">📡</span>RSS feed
        </a>
      </div>
    </div>
    <button
      id="taskbar-start"
      class="taskbar__start"
      aria-haspopup="menu"
      aria-expanded={startMenuOpen}
      onclick={() => (startMenuOpen = !startMenuOpen)}>🪟 Start</button
    >
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

<script lang="ts">
  import "../styles/main.css";
  import { page } from "$app/state";
  import PlayerWindow from "$lib/components/PlayerWindow.svelte";
  import Taskbar from "$lib/components/Taskbar.svelte";

  let { children } = $props();

  const isReleasePage = $derived(page.route.id === "/r/[id]");
  const backdropUrl = $derived((page.data.backdropUrl as string | undefined) ?? null);

  // The SSR body class comes from the handle hook; this keeps it in sync
  // across client-side navigation.
  $effect(() => {
    document.body.classList.toggle("release-page-body", isReleasePage);
  });
</script>

{#if backdropUrl}
  <div class="release-page__backdrop" style="background-image: url('{backdropUrl}')"></div>
{/if}

<header class="header">
  <h1>On The Beach</h1>
  <p class="header__subtitle">Music Tracking</p>
  <div class="header__winbuttons">
    <button class="header__winbtn" aria-label="Minimize" tabindex="-1">_</button>
    <button class="header__winbtn" aria-label="Maximize" tabindex="-1">□</button>
    <button class="header__winbtn header__winbtn--close" aria-label="Close" tabindex="-1">
      ✕
    </button>
  </div>
</header>

{@render children()}

{#if !isReleasePage}
  <footer class="footer">
    <span id="app-version">v{__APP_VERSION__}</span>
  </footer>
{/if}

<PlayerWindow />

<Taskbar showStart={!isReleasePage} showClock={!isReleasePage} />

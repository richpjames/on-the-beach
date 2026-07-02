<script lang="ts">
  import { player } from "../player.svelte";

  let windowEl: HTMLElement | undefined = $state();

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

  function stop(): void {
    player.stop();
    // Drop any drag positioning so the next playback opens in the default spot
    if (windowEl) {
      windowEl.style.removeProperty("left");
      windowEl.style.removeProperty("top");
      windowEl.style.removeProperty("bottom");
      windowEl.style.removeProperty("right");
    }
  }
</script>

<div
  id="now-playing-player"
  class="player-window"
  class:player-window--video={player.playerType === "video"}
  class:player-window--apple-music={player.isAppleMusic}
  bind:this={windowEl}
  hidden={!player.windowVisible}
  aria-hidden={player.windowVisible ? undefined : "true"}
>
  <div
    class="player-window__titlebar"
    id="player-titlebar"
    onmousedown={onTitlebarMousedown}
    role="presentation"
  >
    <span class="player-window__icon" aria-hidden="true">♫</span>
    <span class="player-window__title" id="player-title-text"
      >{player.active ? player.label : "Now Playing"}</span
    >
    <div class="player-window__winbtns">
      <button
        class="player-window__winbtn"
        id="player-minimize"
        aria-label="Minimize"
        title="Minimize"
        onclick={() => player.minimize()}>_</button
      >
      <button
        class="player-window__winbtn player-window__winbtn--close"
        id="player-close"
        aria-label="Stop playback"
        title="Close"
        onclick={stop}>✕</button
      >
    </div>
  </div>
  <div class="player-window__body" id="player-body">
    {#if player.src !== null}
      {#if player.playerType === "video"}
        <iframe
          src={player.src}
          title="YouTube player"
          seamless
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowfullscreen
        ></iframe>
      {:else}
        <iframe src={player.src} title="Bandcamp player" seamless allow="autoplay; encrypted-media"
        ></iframe>
      {/if}
    {/if}
  </div>
</div>

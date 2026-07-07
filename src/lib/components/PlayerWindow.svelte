<script lang="ts">
  import { player } from "../player.svelte";
  import { musickit, togglePlay, seek, authorize } from "../musickit.svelte";

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

  // ── Apple Music (MusicKit) transport ──────────────────────────────────────
  // Prefer MusicKit's own now-playing metadata once it resolves, falling back
  // to the label the caller supplied when starting playback.
  const amTitle = $derived(musickit.title || player.label);
  const amArtist = $derived(musickit.title ? musickit.artist : "");

  function formatTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
    const total = Math.floor(seconds);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function onSeek(e: Event): void {
    const value = Number((e.currentTarget as HTMLInputElement).value);
    void seek(value);
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
    {#if player.isAppleMusic}
      <div class="am-player" id="apple-music-player">
        <div class="am-player__top">
          <div class="am-player__artwork" aria-hidden="true">
            {#if musickit.artworkUrl}
              <img src={musickit.artworkUrl} alt="" />
            {:else}
              <span class="am-player__artwork-placeholder">♫</span>
            {/if}
          </div>
          <div class="am-player__meta">
            <div class="am-player__badge">Apple Music</div>
            <div class="am-player__title" title={amTitle}>{amTitle}</div>
            {#if amArtist}
              <div class="am-player__artist" title={amArtist}>{amArtist}</div>
            {/if}
          </div>
        </div>

        <div class="am-player__scrubber">
          <span class="am-player__time">{formatTime(musickit.position)}</span>
          <input
            class="am-player__range"
            type="range"
            min="0"
            max={Math.max(1, Math.floor(musickit.duration))}
            value={Math.floor(musickit.position)}
            step="1"
            aria-label="Seek"
            disabled={musickit.duration <= 0}
            oninput={onSeek}
          />
          <span class="am-player__time">{formatTime(musickit.duration)}</span>
        </div>

        <div class="am-player__controls">
          <button
            class="am-player__play"
            id="apple-music-play"
            type="button"
            aria-label={musickit.playing ? "Pause" : "Play"}
            disabled={musickit.loadingTrack}
            onclick={() => togglePlay()}
          >
            {#if musickit.loadingTrack}…{:else if musickit.playing}❚❚{:else}▶{/if}
          </button>

          {#if !musickit.authorized}
            <button
              class="am-player__signin"
              id="apple-music-signin"
              type="button"
              onclick={() => authorize()}>Sign in to Apple Music</button
            >
          {/if}
        </div>

        {#if musickit.error}
          <div class="am-player__error" role="status">{musickit.error}</div>
        {:else if !musickit.authorized}
          <div class="am-player__hint">Sign in to play the full track.</div>
        {/if}
      </div>
    {:else if player.src !== null}
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

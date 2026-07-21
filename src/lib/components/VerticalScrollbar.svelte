<script lang="ts">
  /**
   * Retro vertical scrollbar bound to a scrollable target element. Mirrors the
   * custom scrollbar behaviour of the pre-SvelteKit app shell: step buttons
   * with press-and-hold repeat, track paging, and a draggable thumb.
   */
  let {
    target,
    id,
    trackId,
    thumbId,
    buttonAttr = "data-scroll-btn",
    syncKey = 0,
  }: {
    target: HTMLElement | undefined;
    id: string;
    trackId: string;
    thumbId: string;
    /** Attribute name used on the up/down buttons (kept for test/CSS parity). */
    buttonAttr?: string;
    /** Change to force a re-sync after content updates. */
    syncKey?: unknown;
  } = $props();

  const MIN_THUMB_HEIGHT = 56;

  let trackEl: HTMLElement | undefined = $state();
  let thumbHeight = $state(0);
  let thumbTop = $state(0);
  let hasOverflow = $state(false);

  let repeatTimer: ReturnType<typeof setInterval> | null = null;
  let drag: { startY: number; startTop: number } | null = null;

  function sync(): void {
    if (!target || !trackEl) return;
    const scrollRange = target.scrollHeight - target.clientHeight;
    hasOverflow = scrollRange > 0;

    const trackHeight = trackEl.clientHeight;
    if (!hasOverflow || trackHeight <= 0) {
      thumbHeight = trackHeight;
      thumbTop = 0;
      return;
    }

    thumbHeight = Math.max(
      MIN_THUMB_HEIGHT,
      Math.floor((target.clientHeight / target.scrollHeight) * trackHeight),
    );
    const maxThumbTop = Math.max(trackHeight - thumbHeight, 0);
    thumbTop = Math.round(maxThumbTop * (target.scrollTop / scrollRange));
  }

  $effect(() => {
    void syncKey;
    if (!target) return;

    sync();
    requestAnimationFrame(sync);

    const el = target;
    el.addEventListener("scroll", sync);
    window.addEventListener("resize", sync);
    const resizeObserver = new ResizeObserver(sync);
    resizeObserver.observe(el);

    return () => {
      el.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
      resizeObserver.disconnect();
    };
  });

  function scrollByStep(delta: number): void {
    target?.scrollBy({ top: delta, behavior: "auto" });
  }

  function startRepeatScroll(delta: number): void {
    stopRepeatScroll();
    repeatTimer = setInterval(() => scrollByStep(delta), 60);
  }

  function stopRepeatScroll(): void {
    if (repeatTimer) {
      clearInterval(repeatTimer);
      repeatTimer = null;
    }
  }

  $effect(() => {
    document.addEventListener("pointerup", stopRepeatScroll);
    window.addEventListener("blur", stopRepeatScroll);
    return () => {
      document.removeEventListener("pointerup", stopRepeatScroll);
      window.removeEventListener("blur", stopRepeatScroll);
      stopRepeatScroll();
    };
  });

  function onTrackPointerDown(event: PointerEvent): void {
    if (!target || !trackEl) return;
    if ((event.target as HTMLElement).id === thumbId) return;

    const scrollRange = target.scrollHeight - target.clientHeight;
    if (scrollRange <= 0) return;

    const maxThumbTop = Math.max(trackEl.clientHeight - thumbHeight, 0);
    if (maxThumbTop <= 0) return;

    // Jump the thumb so its centre sits under the pointer, then scroll there,
    // rather than paging by a fixed step. This makes a click travel to the
    // clicked region instead of hopping around.
    event.preventDefault();
    const trackRect = trackEl.getBoundingClientRect();
    const clickOffset = event.clientY - trackRect.top;
    const nextTop = Math.max(0, Math.min(maxThumbTop, clickOffset - thumbHeight / 2));
    target.scrollTop = (nextTop / maxThumbTop) * scrollRange;

    // Hand off to the drag logic so the thumb sticks to the pointer if the
    // user keeps dragging after the initial click.
    if (event.pointerId !== undefined && typeof trackEl.setPointerCapture === "function") {
      trackEl.setPointerCapture(event.pointerId);
    }
    drag = { startY: event.clientY, startTop: nextTop };
    document.addEventListener("pointermove", onDragMove);
    document.addEventListener("pointerup", onDragEnd, { once: true });
    document.addEventListener("pointercancel", onDragEnd, { once: true });
  }

  function onDragMove(event: PointerEvent): void {
    if (!drag || !target || !trackEl) return;

    const scrollRange = target.scrollHeight - target.clientHeight;
    if (scrollRange <= 0) return;

    const maxThumbTop = Math.max(trackEl.clientHeight - thumbHeight, 0);
    if (maxThumbTop <= 0) return;

    const nextTop = Math.max(
      0,
      Math.min(maxThumbTop, drag.startTop + (event.clientY - drag.startY)),
    );
    target.scrollTop = (nextTop / maxThumbTop) * scrollRange;
  }

  function onDragEnd(): void {
    drag = null;
    document.removeEventListener("pointermove", onDragMove);
  }

  function onThumbPointerDown(event: PointerEvent): void {
    event.preventDefault();
    const thumb = event.currentTarget as HTMLElement;
    if (event.pointerId !== undefined && typeof thumb.setPointerCapture === "function") {
      thumb.setPointerCapture(event.pointerId);
    }
    drag = { startY: event.clientY, startTop: thumbTop };
    document.addEventListener("pointermove", onDragMove);
    document.addEventListener("pointerup", onDragEnd, { once: true });
    document.addEventListener("pointercancel", onDragEnd, { once: true });
  }
</script>

<div {id} class="music-scrollbar" class:is-disabled={!hasOverflow}>
  <button
    type="button"
    class="music-scrollbar__button"
    {...{ [buttonAttr]: "up" }}
    aria-label="Scroll up"
    tabindex="-1"
    onclick={() => scrollByStep(-40)}
    onpointerdown={() => startRepeatScroll(-40)}
    onpointerup={stopRepeatScroll}
    onpointercancel={stopRepeatScroll}
    onpointerleave={stopRepeatScroll}
  >
    ▲
  </button>
  <div
    id={trackId}
    class="music-scrollbar__track"
    role="presentation"
    bind:this={trackEl}
    onpointerdown={onTrackPointerDown}
  >
    <div
      id={thumbId}
      class="music-scrollbar__thumb"
      role="presentation"
      style="height: {thumbHeight}px; top: {thumbTop}px"
      onpointerdown={onThumbPointerDown}
    ></div>
  </div>
  <button
    type="button"
    class="music-scrollbar__button"
    {...{ [buttonAttr]: "down" }}
    aria-label="Scroll down"
    tabindex="-1"
    onclick={() => scrollByStep(40)}
    onpointerdown={() => startRepeatScroll(40)}
    onpointerup={stopRepeatScroll}
    onpointercancel={stopRepeatScroll}
    onpointerleave={stopRepeatScroll}
  >
    ▼
  </button>
</div>

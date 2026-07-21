<script lang="ts">
  /** Retro horizontal scrollbar for the stack bar. */
  let {
    target,
    id,
    trackId,
    thumbId,
    syncKey = 0,
  }: {
    target: HTMLElement | undefined;
    id: string;
    trackId: string;
    thumbId: string;
    syncKey?: unknown;
  } = $props();

  const MIN_THUMB_WIDTH = 42;

  let trackEl: HTMLElement | undefined = $state();
  let thumbWidth = $state(0);
  let thumbLeft = $state(0);
  let hasOverflow = $state(false);

  let repeatTimer: ReturnType<typeof setInterval> | null = null;
  let drag: { startX: number; startLeft: number } | null = null;

  function sync(): void {
    if (!target || !trackEl) return;
    const scrollRange = target.scrollWidth - target.clientWidth;
    hasOverflow = scrollRange > 0;

    const trackWidth = trackEl.clientWidth;
    if (!hasOverflow || trackWidth <= 0) {
      thumbWidth = trackWidth;
      thumbLeft = 0;
      return;
    }

    thumbWidth = Math.max(
      MIN_THUMB_WIDTH,
      Math.floor((target.clientWidth / target.scrollWidth) * trackWidth),
    );
    const maxThumbLeft = Math.max(trackWidth - thumbWidth, 0);
    thumbLeft = Math.round(maxThumbLeft * (target.scrollLeft / scrollRange));
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
    target?.scrollBy({ left: delta, behavior: "auto" });
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
    // Pointer events unify mouse, touch and pen so the retro scrollbar works
    // when dragged with a finger, not just a mouse.
    document.addEventListener("pointerup", stopRepeatScroll);
    document.addEventListener("pointercancel", stopRepeatScroll);
    window.addEventListener("blur", stopRepeatScroll);
    return () => {
      document.removeEventListener("pointerup", stopRepeatScroll);
      document.removeEventListener("pointercancel", stopRepeatScroll);
      window.removeEventListener("blur", stopRepeatScroll);
      stopRepeatScroll();
    };
  });

  function onTrackPointerDown(event: PointerEvent): void {
    if (!target || !trackEl) return;
    if ((event.target as HTMLElement).id === thumbId) return;

    const scrollRange = target.scrollWidth - target.clientWidth;
    if (scrollRange <= 0) return;

    const maxThumbLeft = Math.max(trackEl.clientWidth - thumbWidth, 0);
    if (maxThumbLeft <= 0) return;

    // Jump the thumb so its centre sits under the pointer, then scroll there,
    // rather than paging by a fixed step. This makes a click travel to the
    // clicked region instead of hopping around.
    event.preventDefault();
    const trackRect = trackEl.getBoundingClientRect();
    const clickOffset = event.clientX - trackRect.left;
    const nextLeft = Math.max(0, Math.min(maxThumbLeft, clickOffset - thumbWidth / 2));
    target.scrollLeft = (nextLeft / maxThumbLeft) * scrollRange;

    // Hand off to the drag logic so the thumb sticks to the pointer if the
    // user keeps dragging after the initial click.
    if (event.pointerId !== undefined && typeof trackEl.setPointerCapture === "function") {
      trackEl.setPointerCapture(event.pointerId);
    }
    drag = { startX: event.clientX, startLeft: nextLeft };
    document.addEventListener("pointermove", onDragMove);
    document.addEventListener("pointerup", onDragEnd, { once: true });
    document.addEventListener("pointercancel", onDragEnd, { once: true });
  }

  function onDragMove(event: PointerEvent): void {
    if (!drag || !target || !trackEl) return;

    const scrollRange = target.scrollWidth - target.clientWidth;
    if (scrollRange <= 0) return;

    const maxThumbLeft = Math.max(trackEl.clientWidth - thumbWidth, 0);
    if (maxThumbLeft <= 0) return;

    const nextLeft = Math.max(
      0,
      Math.min(maxThumbLeft, drag.startLeft + (event.clientX - drag.startX)),
    );
    target.scrollLeft = (nextLeft / maxThumbLeft) * scrollRange;
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
    drag = { startX: event.clientX, startLeft: thumbLeft };
    document.addEventListener("pointermove", onDragMove);
    document.addEventListener("pointerup", onDragEnd, { once: true });
    document.addEventListener("pointercancel", onDragEnd, { once: true });
  }
</script>

<div {id} class="stack-scrollbar" class:is-disabled={!hasOverflow} aria-hidden="true">
  <button
    type="button"
    class="stack-scrollbar__button"
    data-stack-scroll-btn="left"
    tabindex="-1"
    onclick={() => scrollByStep(-80)}
    onpointerdown={() => startRepeatScroll(-80)}
    onpointerup={stopRepeatScroll}
    onpointerleave={stopRepeatScroll}
    onpointercancel={stopRepeatScroll}
  >
    ◀
  </button>
  <div
    id={trackId}
    class="stack-scrollbar__track"
    role="presentation"
    bind:this={trackEl}
    onpointerdown={onTrackPointerDown}
  >
    <div
      id={thumbId}
      class="stack-scrollbar__thumb"
      role="presentation"
      style="width: {thumbWidth}px; left: {thumbLeft}px"
      onpointerdown={onThumbPointerDown}
    ></div>
  </div>
  <button
    type="button"
    class="stack-scrollbar__button"
    data-stack-scroll-btn="right"
    tabindex="-1"
    onclick={() => scrollByStep(80)}
    onpointerdown={() => startRepeatScroll(80)}
    onpointerup={stopRepeatScroll}
    onpointerleave={stopRepeatScroll}
    onpointercancel={stopRepeatScroll}
  >
    ▶
  </button>
</div>

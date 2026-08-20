<script lang="ts">
  /**
   * Retro vertical scrollbar bound to a scrollable target element. Mirrors the
   * custom scrollbar behaviour of the pre-SvelteKit app shell: step buttons
   * with press-and-hold repeat, track paging, and a draggable thumb.
   */
  import {
    clampThumbOffset,
    maxThumbOffset,
    measureThumb,
    thumbOffsetForTrackClick,
    thumbOffsetToScroll,
    type ScrollMetrics,
  } from "../../ui/domain/scrollbar";

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
  /** One "line" of the list — what a click on an arrow button travels. */
  const STEP = 40;
  /** Hold-to-scroll waits, like a real scrollbar, before it starts repeating. */
  const REPEAT_DELAY_MS = 260;
  /** Held-button scrolling glides at a steady speed instead of lurching. */
  const REPEAT_SPEED = 700;

  let trackEl: HTMLElement | undefined = $state();
  let thumbHeight = $state(0);
  let thumbTop = $state(0);
  let hasOverflow = $state(false);

  let syncFrame: number | null = null;
  let drag: { startY: number; startTop: number } | null = null;

  function metrics(): ScrollMetrics | null {
    if (!target || !trackEl) return null;
    return {
      viewport: target.clientHeight,
      content: target.scrollHeight,
      offset: target.scrollTop,
      track: trackEl.clientHeight,
      minThumb: MIN_THUMB_HEIGHT,
    };
  }

  function sync(): void {
    const scrollMetrics = metrics();
    if (!scrollMetrics) return;

    const thumb = measureThumb(scrollMetrics);
    hasOverflow = thumb.hasOverflow;
    thumbHeight = thumb.size;
    // While dragging, the thumb belongs to the pointer: re-deriving it from
    // scrollTop here would fight the drag and jitter the thumb.
    if (!drag) thumbTop = thumb.offset;
  }

  /**
   * Measure once per frame. Reading scrollHeight inside every scroll event
   * forces a layout of the whole list, which is what makes scrolling a long
   * playlist stutter.
   */
  function scheduleSync(): void {
    if (syncFrame !== null) return;
    syncFrame = requestAnimationFrame(() => {
      syncFrame = null;
      sync();
    });
  }

  function cancelScheduledSync(): void {
    if (syncFrame !== null) {
      cancelAnimationFrame(syncFrame);
      syncFrame = null;
    }
  }

  $effect(() => {
    void syncKey;
    if (!target) return;

    sync();
    scheduleSync();

    const el = target;
    el.addEventListener("scroll", scheduleSync, { passive: true });
    window.addEventListener("resize", scheduleSync);
    const resizeObserver = new ResizeObserver(scheduleSync);
    resizeObserver.observe(el);
    // The chrome is hidden until the content overflows, so the track measures
    // zero on the first sync; re-measure as soon as it takes up space.
    if (trackEl) resizeObserver.observe(trackEl);
    // Content can grow or shrink without the container resizing (rows added, a
    // panel opened). Without this the thumb keeps a stale size until the next
    // scroll event, which then snaps it into place.
    const contentObserver = new MutationObserver(scheduleSync);
    contentObserver.observe(el, { childList: true, subtree: true });

    return () => {
      el.removeEventListener("scroll", scheduleSync);
      window.removeEventListener("resize", scheduleSync);
      resizeObserver.disconnect();
      contentObserver.disconnect();
      cancelScheduledSync();
    };
  });

  function scrollByStep(delta: number): void {
    target?.scrollBy({ top: delta, behavior: "auto" });
  }

  let repeatFrame: number | null = null;

  /** Step once on press, then glide while the button stays held. */
  function startRepeatScroll(direction: -1 | 1): void {
    stopRepeatScroll();
    scrollByStep(direction * STEP);

    const pressedAt = performance.now();
    let previous = pressedAt;
    const tick = (now: number): void => {
      if (now - pressedAt >= REPEAT_DELAY_MS) {
        scrollByStep((direction * REPEAT_SPEED * (now - previous)) / 1000);
      }
      previous = now;
      repeatFrame = requestAnimationFrame(tick);
    };
    repeatFrame = requestAnimationFrame(tick);
  }

  function stopRepeatScroll(): void {
    if (repeatFrame !== null) {
      cancelAnimationFrame(repeatFrame);
      repeatFrame = null;
    }
  }

  /**
   * Pointer presses already stepped in `startRepeatScroll`; only synthetic and
   * keyboard activations (`detail === 0`) still need the click to scroll.
   */
  function onButtonClick(event: MouseEvent, direction: -1 | 1): void {
    if (event.detail !== 0) return;
    scrollByStep(direction * STEP);
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

  function beginDrag(event: PointerEvent, capturedBy: HTMLElement, startTop: number): void {
    if (event.pointerId !== undefined && typeof capturedBy.setPointerCapture === "function") {
      capturedBy.setPointerCapture(event.pointerId);
    }
    drag = { startY: event.clientY, startTop };
    document.addEventListener("pointermove", onDragMove);
    document.addEventListener("pointerup", onDragEnd, { once: true });
    document.addEventListener("pointercancel", onDragEnd, { once: true });
  }

  function onTrackPointerDown(event: PointerEvent): void {
    if (!target || !trackEl) return;
    if ((event.target as HTMLElement).id === thumbId) return;

    const scrollMetrics = metrics();
    if (!scrollMetrics || maxThumbOffset(scrollMetrics) <= 0) return;

    // Jump the thumb so its centre sits under the pointer, then scroll there,
    // rather than paging by a fixed step. This makes a click travel to the
    // clicked region instead of hopping around.
    event.preventDefault();
    const trackRect = trackEl.getBoundingClientRect();
    const nextTop = thumbOffsetForTrackClick(event.clientY - trackRect.top, scrollMetrics);
    thumbTop = nextTop;
    target.scrollTop = thumbOffsetToScroll(nextTop, scrollMetrics);

    // Hand off to the drag logic so the thumb sticks to the pointer if the
    // user keeps dragging after the initial click.
    beginDrag(event, trackEl, nextTop);
  }

  function onDragMove(event: PointerEvent): void {
    if (!drag || !target) return;

    const scrollMetrics = metrics();
    if (!scrollMetrics || maxThumbOffset(scrollMetrics) <= 0) return;

    const nextTop = clampThumbOffset(
      drag.startTop + (event.clientY - drag.startY),
      scrollMetrics,
    );
    thumbTop = nextTop;
    target.scrollTop = thumbOffsetToScroll(nextTop, scrollMetrics);
  }

  function onDragEnd(): void {
    drag = null;
    document.removeEventListener("pointermove", onDragMove);
    scheduleSync();
  }

  function onThumbPointerDown(event: PointerEvent): void {
    event.preventDefault();
    beginDrag(event, event.currentTarget as HTMLElement, thumbTop);
  }

  /** Keep the inline styles short so a fractional thumb doesn't churn the DOM. */
  function px(value: number): string {
    return `${Math.round(value * 100) / 100}px`;
  }
</script>

<div {id} class="music-scrollbar" class:is-disabled={!hasOverflow}>
  <button
    type="button"
    class="music-scrollbar__button"
    {...{ [buttonAttr]: "up" }}
    aria-label="Scroll up"
    tabindex="-1"
    onclick={(event) => onButtonClick(event, -1)}
    onpointerdown={() => startRepeatScroll(-1)}
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
      style="height: {px(thumbHeight)}; transform: translateY({px(thumbTop)})"
      onpointerdown={onThumbPointerDown}
    ></div>
  </div>
  <button
    type="button"
    class="music-scrollbar__button"
    {...{ [buttonAttr]: "down" }}
    aria-label="Scroll down"
    tabindex="-1"
    onclick={(event) => onButtonClick(event, 1)}
    onpointerdown={() => startRepeatScroll(1)}
    onpointerup={stopRepeatScroll}
    onpointercancel={stopRepeatScroll}
    onpointerleave={stopRepeatScroll}
  >
    ▼
  </button>
</div>

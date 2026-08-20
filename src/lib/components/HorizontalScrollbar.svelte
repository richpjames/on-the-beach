<script lang="ts">
  /** Retro horizontal scrollbar for the stack bar. */
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
    syncKey = 0,
  }: {
    target: HTMLElement | undefined;
    id: string;
    trackId: string;
    thumbId: string;
    syncKey?: unknown;
  } = $props();

  const MIN_THUMB_WIDTH = 42;
  /** What a click on an arrow button travels — roughly one stack tab. */
  const STEP = 80;
  /** Hold-to-scroll waits, like a real scrollbar, before it starts repeating. */
  const REPEAT_DELAY_MS = 260;
  /** Held-button scrolling glides at a steady speed instead of lurching. */
  const REPEAT_SPEED = 700;

  let trackEl: HTMLElement | undefined = $state();
  let thumbWidth = $state(0);
  let thumbLeft = $state(0);
  let hasOverflow = $state(false);

  let syncFrame: number | null = null;
  let drag: { startX: number; startLeft: number } | null = null;

  function metrics(): ScrollMetrics | null {
    if (!target || !trackEl) return null;
    return {
      viewport: target.clientWidth,
      content: target.scrollWidth,
      offset: target.scrollLeft,
      track: trackEl.clientWidth,
      minThumb: MIN_THUMB_WIDTH,
    };
  }

  function sync(): void {
    const scrollMetrics = metrics();
    if (!scrollMetrics) return;

    const thumb = measureThumb(scrollMetrics);
    hasOverflow = thumb.hasOverflow;
    thumbWidth = thumb.size;
    // While dragging, the thumb belongs to the pointer: re-deriving it from
    // scrollLeft here would fight the drag and jitter the thumb.
    if (!drag) thumbLeft = thumb.offset;
  }

  /** Measure once per frame rather than inside every scroll event. */
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
    // Tabs are added, removed and re-wrapped without the bar itself resizing;
    // without this the thumb keeps a stale width until the next scroll.
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
    target?.scrollBy({ left: delta, behavior: "auto" });
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

  function beginDrag(event: PointerEvent, capturedBy: HTMLElement, startLeft: number): void {
    if (event.pointerId !== undefined && typeof capturedBy.setPointerCapture === "function") {
      capturedBy.setPointerCapture(event.pointerId);
    }
    drag = { startX: event.clientX, startLeft };
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
    const nextLeft = thumbOffsetForTrackClick(event.clientX - trackRect.left, scrollMetrics);
    thumbLeft = nextLeft;
    target.scrollLeft = thumbOffsetToScroll(nextLeft, scrollMetrics);

    // Hand off to the drag logic so the thumb sticks to the pointer if the
    // user keeps dragging after the initial click.
    beginDrag(event, trackEl, nextLeft);
  }

  function onDragMove(event: PointerEvent): void {
    if (!drag || !target) return;

    const scrollMetrics = metrics();
    if (!scrollMetrics || maxThumbOffset(scrollMetrics) <= 0) return;

    const nextLeft = clampThumbOffset(
      drag.startLeft + (event.clientX - drag.startX),
      scrollMetrics,
    );
    thumbLeft = nextLeft;
    target.scrollLeft = thumbOffsetToScroll(nextLeft, scrollMetrics);
  }

  function onDragEnd(): void {
    drag = null;
    document.removeEventListener("pointermove", onDragMove);
    scheduleSync();
  }

  function onThumbPointerDown(event: PointerEvent): void {
    event.preventDefault();
    beginDrag(event, event.currentTarget as HTMLElement, thumbLeft);
  }

  /** Keep the inline styles short so a fractional thumb doesn't churn the DOM. */
  function px(value: number): string {
    return `${Math.round(value * 100) / 100}px`;
  }
</script>

<div {id} class="stack-scrollbar" class:is-disabled={!hasOverflow} aria-hidden="true">
  <button
    type="button"
    class="stack-scrollbar__button"
    data-stack-scroll-btn="left"
    tabindex="-1"
    onclick={(event) => onButtonClick(event, -1)}
    onpointerdown={() => startRepeatScroll(-1)}
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
      style="width: {px(thumbWidth)}; transform: translateX({px(thumbLeft)})"
      onpointerdown={onThumbPointerDown}
    ></div>
  </div>
  <button
    type="button"
    class="stack-scrollbar__button"
    data-stack-scroll-btn="right"
    tabindex="-1"
    onclick={(event) => onButtonClick(event, 1)}
    onpointerdown={() => startRepeatScroll(1)}
    onpointerup={stopRepeatScroll}
    onpointerleave={stopRepeatScroll}
    onpointercancel={stopRepeatScroll}
  >
    ▶
  </button>
</div>

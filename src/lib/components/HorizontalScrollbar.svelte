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
    document.addEventListener("mouseup", stopRepeatScroll);
    window.addEventListener("blur", stopRepeatScroll);
    return () => {
      document.removeEventListener("mouseup", stopRepeatScroll);
      window.removeEventListener("blur", stopRepeatScroll);
      stopRepeatScroll();
    };
  });

  function onTrackMouseDown(event: MouseEvent): void {
    if (!target || !trackEl) return;
    if ((event.target as HTMLElement).id === thumbId) return;

    const trackRect = trackEl.getBoundingClientRect();
    const clickOffset = event.clientX - trackRect.left;
    const direction = clickOffset < thumbLeft ? -1 : 1;
    target.scrollBy({
      left: direction * Math.max(80, target.clientWidth * 0.8),
      behavior: "auto",
    });
  }

  function onDragMove(event: MouseEvent): void {
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
    document.removeEventListener("mousemove", onDragMove);
  }

  function onThumbMouseDown(event: MouseEvent): void {
    event.preventDefault();
    drag = { startX: event.clientX, startLeft: thumbLeft };
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragEnd, { once: true });
  }
</script>

<div {id} class="stack-scrollbar" class:is-disabled={!hasOverflow} aria-hidden="true">
  <button
    type="button"
    class="stack-scrollbar__button"
    data-stack-scroll-btn="left"
    tabindex="-1"
    onclick={() => scrollByStep(-80)}
    onmousedown={() => startRepeatScroll(-80)}
    onmouseup={stopRepeatScroll}
    onmouseleave={stopRepeatScroll}
  >
    ◀
  </button>
  <div
    id={trackId}
    class="stack-scrollbar__track"
    role="presentation"
    bind:this={trackEl}
    onmousedown={onTrackMouseDown}
  >
    <div
      id={thumbId}
      class="stack-scrollbar__thumb"
      role="presentation"
      style="width: {thumbWidth}px; left: {thumbLeft}px"
      onmousedown={onThumbMouseDown}
    ></div>
  </div>
  <button
    type="button"
    class="stack-scrollbar__button"
    data-stack-scroll-btn="right"
    tabindex="-1"
    onclick={() => scrollByStep(80)}
    onmousedown={() => startRepeatScroll(80)}
    onmouseup={stopRepeatScroll}
    onmouseleave={stopRepeatScroll}
  >
    ▶
  </button>
</div>

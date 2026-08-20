/**
 * Geometry for the retro custom scrollbars (playlist, link picker, stack bar).
 *
 * The maths is axis-agnostic and kept free of the DOM so it can be unit
 * tested: the components measure the elements and hand the numbers over.
 *
 * Everything here is deliberately fractional — rounding the thumb to whole
 * pixels makes it sit still for several frames and then hop, which is what
 * reads as a "jumpy" scrollbar on a long list.
 */

export type ScrollMetrics = {
  /** Visible length of the scroll container along the axis. */
  viewport: number;
  /** Total scrollable length of its content along the axis. */
  content: number;
  /** Current scroll offset (scrollTop / scrollLeft). */
  offset: number;
  /** Length of the scrollbar track the thumb moves inside. */
  track: number;
  /** Smallest thumb the chrome stays grabbable at. */
  minThumb: number;
};

export type ThumbGeometry = {
  /** Thumb length along the axis, in px. */
  size: number;
  /** Thumb distance from the start of the track, in px. */
  offset: number;
  /** False when the content fits: the scrollbar renders disabled. */
  hasOverflow: boolean;
};

/** How far the content can travel; 0 when everything fits. */
export function scrollRange(metrics: ScrollMetrics): number {
  return Math.max(metrics.content - metrics.viewport, 0);
}

/** How far the thumb can travel; 0 when the thumb fills the track. */
export function maxThumbOffset(metrics: ScrollMetrics): number {
  return Math.max(metrics.track - thumbSize(metrics), 0);
}

/**
 * Thumb length: proportional to how much of the content is visible, floored at
 * `minThumb` so a long list still leaves something you can grab.
 */
export function thumbSize(metrics: ScrollMetrics): number {
  const { viewport, content, track, minThumb } = metrics;
  if (track <= 0) return 0;
  if (content <= 0 || scrollRange(metrics) <= 0) return track;
  const proportional = (viewport / content) * track;
  return Math.min(track, Math.max(minThumb, proportional));
}

/**
 * The thumb position that matches the container's current scroll offset.
 *
 * `hasOverflow` reads the content alone, never the track: the chrome is hidden
 * while it is false, so a track-dependent answer could never become true.
 */
export function measureThumb(metrics: ScrollMetrics): ThumbGeometry {
  const range = scrollRange(metrics);
  const size = thumbSize(metrics);

  if (range <= 0) {
    return { size, offset: 0, hasOverflow: false };
  }

  const travel = maxThumbOffset(metrics);
  const progress = clamp(metrics.offset / range, 0, 1);
  return { size, offset: travel * progress, hasOverflow: true };
}

/** Inverse of {@link measureThumb}: the scroll offset a thumb position means. */
export function thumbOffsetToScroll(offset: number, metrics: ScrollMetrics): number {
  const travel = maxThumbOffset(metrics);
  if (travel <= 0) return 0;
  return (clampThumbOffset(offset, metrics) / travel) * scrollRange(metrics);
}

/** Keep a thumb position inside the track. */
export function clampThumbOffset(offset: number, metrics: ScrollMetrics): number {
  return clamp(offset, 0, maxThumbOffset(metrics));
}

/**
 * Where the thumb should land when the track is clicked at `pointerOffset`
 * (measured from the start of the track): centred under the pointer.
 */
export function thumbOffsetForTrackClick(pointerOffset: number, metrics: ScrollMetrics): number {
  return clampThumbOffset(pointerOffset - thumbSize(metrics) / 2, metrics);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

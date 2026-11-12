/**
 * Geometry for the draggable player window.
 *
 * The window is `position: fixed`, so dragging pins it to viewport coordinates
 * (inline `left`/`top`) and nothing else ever re-anchors it. Unclamped, that
 * is how it could vanish mid-playback: a drag towards an edge could leave
 * nothing of it on screen, and once the viewport later shrank — window resized,
 * phone rotated, another display — an already-dragged window could end up
 * entirely outside it, still playing, with its close button unreachable and
 * the taskbar button only toggling `minimized`. The clamp keeps part of the
 * window on screen at all times so it can always be dragged back.
 *
 * The maths is kept free of the DOM so it can be unit tested: the component
 * measures the window and viewport and hands the numbers over (mirroring
 * `scrollbar.ts`).
 */

export type WindowPosition = {
  left: number;
  top: number;
};

export type WindowBounds = {
  /** Player window width in px. */
  width: number;
  /** Viewport size in px. */
  viewportWidth: number;
  viewportHeight: number;
};

/**
 * Least of the window that must stay visible horizontally. From the right that
 * is the titlebar buttons (minimise, close); from the left, the icon and label.
 * Either way it includes titlebar the drag handle needs to pull it back.
 */
export const MIN_VISIBLE_PX = 80;

/**
 * Least that must stay visible vertically: the titlebar, so a window pushed
 * towards the taskbar keeps its handle (and buttons) on screen.
 */
export const TITLEBAR_PX = 40;

/**
 * Keep a dragged position on screen: at least {@link MIN_VISIBLE_PX} of the
 * window visible horizontally, and the titlebar strip visible vertically.
 * Never dragged past the top edge — a titlebar above the screen has no way
 * back, since only the titlebar is a drag handle.
 */
export function clampWindowPosition(
  position: WindowPosition,
  bounds: WindowBounds,
): WindowPosition {
  const { width, viewportWidth, viewportHeight } = bounds;
  return {
    left: clamp(position.left, -(width - MIN_VISIBLE_PX), viewportWidth - MIN_VISIBLE_PX),
    top: clamp(position.top, 0, Math.max(0, viewportHeight - TITLEBAR_PX)),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

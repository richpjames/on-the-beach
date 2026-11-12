import { describe, expect, it } from "bun:test";

import {
  clampWindowPosition,
  MIN_VISIBLE_PX,
  TITLEBAR_PX,
} from "../../src/ui/logic/player-window-position";

// A typical player window in a typical laptop viewport.
const BOUNDS = { width: 480, viewportWidth: 1280, viewportHeight: 720 };

describe("clampWindowPosition", () => {
  it("leaves an on-screen position untouched", () => {
    expect(clampWindowPosition({ left: 773, top: 455 }, BOUNDS)).toEqual({
      left: 773,
      top: 455,
    });
  });

  it("keeps part of the window visible when dragged past the right edge", () => {
    const { left } = clampWindowPosition({ left: 1276, top: 100 }, BOUNDS);
    expect(left).toBe(BOUNDS.viewportWidth - MIN_VISIBLE_PX);
    // The right of the window is where the titlebar buttons live, so those stay
    // on screen and the close button stays reachable.
    expect(left + BOUNDS.width).toBeGreaterThan(BOUNDS.viewportWidth);
    expect(left + MIN_VISIBLE_PX).toBe(BOUNDS.viewportWidth);
  });

  it("keeps part of the window visible when dragged past the left edge", () => {
    const { left } = clampWindowPosition({ left: -1000, top: 100 }, BOUNDS);
    expect(left).toBe(-(BOUNDS.width - MIN_VISIBLE_PX));
    // The visible part is the right of the window: titlebar buttons included.
    expect(left + BOUNDS.width).toBe(MIN_VISIBLE_PX);
  });

  it("keeps the titlebar strip visible when dragged towards the taskbar", () => {
    const { top } = clampWindowPosition({ left: 100, top: 2000 }, BOUNDS);
    expect(top).toBe(BOUNDS.viewportHeight - TITLEBAR_PX);
  });

  it("never lets the window above the top edge, where its drag handle is gone", () => {
    const { top } = clampWindowPosition({ left: 100, top: -400 }, BOUNDS);
    expect(top).toBe(0);
  });

  it("pulls a stranded window back when the viewport shrinks", () => {
    // Dragged to the right of a wide screen, then the window is resized down.
    const dragged = clampWindowPosition({ left: 1073, top: 489 }, BOUNDS);
    const afterShrink = clampWindowPosition(dragged, {
      ...BOUNDS,
      viewportWidth: 900,
      viewportHeight: 640,
    });
    // The horizontal overflow is pulled back on screen; the top was already
    // within bounds and stays put.
    expect(afterShrink.left).toBe(900 - MIN_VISIBLE_PX);
    expect(afterShrink.top).toBe(489);
  });

  it("keeps a sane range on a viewport narrower than the window", () => {
    const mobile = { ...BOUNDS, viewportWidth: 320, viewportHeight: 640 };
    const clamped = clampWindowPosition({ left: 300, top: 100 }, mobile);
    expect(clamped.left).toBe(320 - MIN_VISIBLE_PX);
    // And the two bounds still describe a usable range, not an inverted one.
    expect(-(BOUNDS.width - MIN_VISIBLE_PX)).toBeLessThan(320 - MIN_VISIBLE_PX);
  });
});

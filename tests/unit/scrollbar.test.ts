import { describe, expect, test } from "bun:test";
import {
  clampThumbOffset,
  maxThumbOffset,
  measureThumb,
  scrollRange,
  thumbOffsetForTrackClick,
  thumbOffsetToScroll,
  thumbSize,
  type ScrollMetrics,
} from "../../src/ui/logic/scrollbar";

/** A long playlist: 300 cards in a short window, so the thumb hits its floor. */
const longList: ScrollMetrics = {
  viewport: 600,
  content: 27_600,
  offset: 0,
  track: 540,
  minThumb: 56,
};

/** A short list where the thumb is comfortably bigger than the minimum. */
const shortList: ScrollMetrics = {
  viewport: 600,
  content: 1200,
  offset: 0,
  track: 540,
  minThumb: 56,
};

describe("thumbSize", () => {
  test("is proportional to the visible fraction of the content", () => {
    expect(thumbSize(shortList)).toBe(270);
  });

  test("never shrinks below the grabbable minimum", () => {
    expect(thumbSize(longList)).toBe(56);
  });

  test("fills the track when the content fits", () => {
    expect(thumbSize({ ...shortList, content: 600 })).toBe(540);
  });

  test("never overflows the track", () => {
    expect(thumbSize({ ...longList, track: 40 })).toBe(40);
  });
});

describe("measureThumb", () => {
  test("reports no overflow when everything is visible", () => {
    expect(measureThumb({ ...shortList, content: 600 })).toEqual({
      size: 540,
      offset: 0,
      hasOverflow: false,
    });
  });

  test("puts the thumb at the start of the track at the top of the list", () => {
    expect(measureThumb(longList).offset).toBe(0);
  });

  test("puts the thumb at the end of the track at the bottom of the list", () => {
    const bottom = { ...longList, offset: scrollRange(longList) };
    expect(measureThumb(bottom).offset).toBeCloseTo(maxThumbOffset(longList), 5);
  });

  test("tracks scroll position without rounding, so the thumb glides", () => {
    // One frame of a slow scroll: a whole-pixel thumb would not move at all.
    const scrolled = measureThumb({ ...longList, offset: 6 });
    expect(scrolled.offset).toBeGreaterThan(0);
    expect(scrolled.offset).toBeLessThan(1);
  });

  test("clamps an overscrolled offset instead of running past the track", () => {
    const overscrolled = measureThumb({ ...longList, offset: 99_999 });
    expect(overscrolled.offset).toBe(maxThumbOffset(longList));
    const rubberBanded = measureThumb({ ...longList, offset: -80 });
    expect(rubberBanded.offset).toBe(0);
  });
});

describe("thumbOffsetToScroll", () => {
  test("is the inverse of measureThumb", () => {
    for (const offset of [0, 137, 4021, scrollRange(longList)]) {
      const thumb = measureThumb({ ...longList, offset });
      expect(thumbOffsetToScroll(thumb.offset, longList)).toBeCloseTo(offset, 5);
    }
  });

  test("stays put when the thumb cannot travel", () => {
    const fits = { ...shortList, content: 600 };
    expect(thumbOffsetToScroll(120, fits)).toBe(0);
  });
});

describe("clampThumbOffset", () => {
  test("keeps a dragged thumb inside the track", () => {
    expect(clampThumbOffset(-40, longList)).toBe(0);
    expect(clampThumbOffset(10_000, longList)).toBe(484);
  });
});

describe("thumbOffsetForTrackClick", () => {
  test("centres the thumb under the pointer", () => {
    expect(thumbOffsetForTrackClick(300, longList)).toBe(272);
  });

  test("clamps at both ends of the track", () => {
    expect(thumbOffsetForTrackClick(4, longList)).toBe(0);
    expect(thumbOffsetForTrackClick(538, longList)).toBe(maxThumbOffset(longList));
  });
});

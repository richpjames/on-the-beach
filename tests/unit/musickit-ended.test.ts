import { describe, expect, it } from "bun:test";

import { createPlaybackGeneration, isEndedState } from "../../src/lib/musickit-ended";

describe("isEndedState", () => {
  it("matches the PlaybackStates.ended value when present", () => {
    const states = { ended: 5, completed: 8 };
    expect(isEndedState(5, states)).toBe(true);
    expect(isEndedState(3, states)).toBe(false);
    expect(isEndedState(8, states)).toBe(false);
  });

  it("falls back to completed when ended is missing", () => {
    const states = { completed: 8 };
    expect(isEndedState(8, states)).toBe(true);
    expect(isEndedState(5, states)).toBe(false);
  });

  it("falls back to the numeric 5 when the states table is bare or absent", () => {
    expect(isEndedState(5, {})).toBe(true);
    expect(isEndedState(2, {})).toBe(false);
    expect(isEndedState(5, undefined)).toBe(true);
  });
});

describe("createPlaybackGeneration", () => {
  it("notifies for nothing before any playback began", () => {
    const gate = createPlaybackGeneration();
    expect(gate.consumeIfLive()).toBe(false);
  });

  it("notifies once for the live playback, swallowing duplicate ended events", () => {
    const gate = createPlaybackGeneration();
    gate.begin();
    expect(gate.consumeIfLive()).toBe(true);
    expect(gate.consumeIfLive()).toBe(false);
  });

  it("ignores an ended that arrives after teardown retired the generation", () => {
    const gate = createPlaybackGeneration();
    gate.begin();
    gate.retire();
    expect(gate.consumeIfLive()).toBe(false);
  });

  it("notifies again for the next playback after a superseded one", () => {
    const gate = createPlaybackGeneration();
    gate.begin();
    gate.retire(); // a new release took over mid-flight
    gate.begin();
    expect(gate.consumeIfLive()).toBe(true);
  });
});

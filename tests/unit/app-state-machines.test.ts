import { describe, expect, it } from "bun:test";

import { initialAddFormState, transitionAddFormState } from "../../src/ui/state/add-form-machine";
import { initialAppState, transitionAppState } from "../../src/ui/state/app-machine";
import {
  initialRatingState,
  resolveRatingClick,
  transitionRatingState,
} from "../../src/ui/state/rating-machine";

describe("app state machine", () => {
  it("tracks filter and stack selection", () => {
    let state = transitionAppState(initialAppState, { type: "APP_READY" });
    state = transitionAppState(state, { type: "FILTER_SELECTED", filter: "listened" });
    state = transitionAppState(state, { type: "STACK_SELECTED", stackId: 4 });

    expect(state.isReady).toBe(true);
    expect(state.currentFilter).toBe("listened");
    expect(state.currentStack).toBe(4);

    state = transitionAppState(state, { type: "STACK_SELECTED_ALL" });
    expect(state.currentStack).toBeNull();
  });

  it("resets active stack when deleted", () => {
    let state = transitionAppState(initialAppState, { type: "STACK_SELECTED", stackId: 2 });
    state = transitionAppState(state, {
      type: "STACKS_LOADED",
      stacks: [
        { id: 2, name: "Dub", created_at: "", item_count: 1 },
        { id: 3, name: "House", created_at: "", item_count: 1 },
      ],
    });

    state = transitionAppState(state, { type: "STACK_DELETED", stackId: 2 });
    expect(state.currentStack).toBeNull();
    expect(state.stacks.map((stack) => stack.id)).toEqual([3]);
  });
});

describe("add form state machine", () => {
  it("adds, toggles, and clears selected stacks", () => {
    let state = transitionAddFormState(initialAddFormState, { type: "INITIALIZED" });
    state = transitionAddFormState(state, { type: "STACK_ADDED", stackId: 5 });
    state = transitionAddFormState(state, { type: "STACK_ADDED", stackId: 5 });
    state = transitionAddFormState(state, { type: "STACK_TOGGLED", stackId: 7, checked: true });
    state = transitionAddFormState(state, { type: "STACK_REMOVED", stackId: 5 });

    expect(state.initialized).toBe(true);
    expect(state.selectedStackIds).toEqual([7]);

    state = transitionAddFormState(state, { type: "CLEAR_STACKS" });
    expect(state.selectedStackIds).toEqual([]);
  });

  it("tracks scan idle/scanning states", () => {
    let state = transitionAddFormState(initialAddFormState, { type: "SCAN_STARTED" });
    expect(state.scanState).toBe("scanning");

    state = transitionAddFormState(state, { type: "SCAN_FINISHED" });
    expect(state.scanState).toBe("idle");
  });
});

describe("rating state machine", () => {
  it("marks a checked star as clearable when clicked again", () => {
    const state = transitionRatingState(initialRatingState, {
      type: "POINTER_DOWN_ON_CHECKED",
      itemId: 9,
      value: 3,
    });

    const clearResult = resolveRatingClick(state, 9, 3);
    expect(clearResult.shouldClear).toBe(true);
    expect(clearResult.state.clearCandidate).toBeNull();
  });

  it("does not clear when rating click does not match candidate", () => {
    const state = transitionRatingState(initialRatingState, {
      type: "POINTER_DOWN_ON_CHECKED",
      itemId: 9,
      value: 3,
    });

    const clearResult = resolveRatingClick(state, 9, 4);
    expect(clearResult.shouldClear).toBe(false);
    expect(clearResult.state.clearCandidate).toBeNull();
  });
});

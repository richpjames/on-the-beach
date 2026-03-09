import { createActor } from "xstate";
import { describe, expect, it } from "bun:test";

import { addFormMachine } from "../../src/ui/state/add-form-machine";
import { appMachine } from "../../src/ui/state/app-machine";
import {
  initialRatingState,
  resolveRatingClick,
  transitionRatingState,
} from "../../src/ui/state/rating-machine";

describe("app state machine", () => {
  it("tracks filter and stack selection", () => {
    const actor = createActor(appMachine).start();

    actor.send({ type: "APP_READY" });
    actor.send({ type: "FILTER_SELECTED", filter: "listened" });
    actor.send({ type: "STACK_SELECTED", stackId: 4 });
    actor.send({ type: "SEARCH_UPDATED", query: "dub" });
    actor.send({ type: "SORT_UPDATED", sort: "star-rating" });

    const ctx = actor.getSnapshot().context;
    expect(ctx.isReady).toBe(true);
    expect(ctx.currentFilter).toBe("listened");
    expect(ctx.currentStack).toBe(4);
    expect(ctx.searchQuery).toBe("dub");
    expect(ctx.currentSort).toBe("star-rating");

    actor.send({ type: "STACK_SELECTED_ALL" });
    expect(actor.getSnapshot().context.currentStack).toBeNull();
  });

  it("resets active stack when deleted", () => {
    const actor = createActor(appMachine).start();

    actor.send({ type: "STACK_SELECTED", stackId: 2 });
    actor.send({
      type: "STACKS_LOADED",
      stacks: [
        { id: 2, name: "Dub", created_at: "", parent_stack_id: null, item_count: 1 },
        { id: 3, name: "House", created_at: "", parent_stack_id: null, item_count: 1 },
      ],
    });

    actor.send({ type: "STACK_DELETED", stackId: 2 });
    const ctx = actor.getSnapshot().context;
    expect(ctx.currentStack).toBeNull();
    expect(ctx.stacks.map((stack) => stack.id)).toEqual([3]);
  });
});

describe("add form state machine", () => {
  it("adds, toggles, and clears selected stacks", () => {
    const actor = createActor(addFormMachine).start();

    actor.send({ type: "INITIALIZED" });
    actor.send({ type: "STACK_ADDED", stackId: 5 });
    actor.send({ type: "STACK_ADDED", stackId: 5 }); // duplicate — should be ignored
    actor.send({ type: "STACK_TOGGLED", stackId: 7, checked: true });
    actor.send({ type: "STACK_REMOVED", stackId: 5 });

    const ctx = actor.getSnapshot().context;
    expect(ctx.initialized).toBe(true);
    expect(ctx.selectedStackIds).toEqual([7]);

    actor.send({ type: "CLEAR_STACKS" });
    expect(actor.getSnapshot().context.selectedStackIds).toEqual([]);
  });

  it("tracks scan idle/scanning states", () => {
    const actor = createActor(addFormMachine).start();

    actor.send({ type: "SCAN_STARTED" });
    expect(actor.getSnapshot().context.scanState).toBe("scanning");

    actor.send({ type: "SCAN_FINISHED" });
    expect(actor.getSnapshot().context.scanState).toBe("idle");
  });

  it("tracks submit loading state", () => {
    const actor = createActor(addFormMachine).start();

    expect(actor.getSnapshot().context.submitState).toBe("idle");

    actor.send({ type: "SUBMIT_STARTED" });
    expect(actor.getSnapshot().context.submitState).toBe("submitting");

    actor.send({ type: "SUBMIT_FINISHED" });
    expect(actor.getSnapshot().context.submitState).toBe("idle");
  });

  it("tracks submit error state", () => {
    const actor = createActor(addFormMachine).start();

    actor.send({ type: "SUBMIT_STARTED" });
    actor.send({ type: "SUBMIT_ERROR" });
    expect(actor.getSnapshot().context.submitState).toBe("error");

    actor.send({ type: "SUBMIT_FINISHED" });
    expect(actor.getSnapshot().context.submitState).toBe("idle");
  });
});

describe("add form machine — secondary fields and link picker", () => {
  it("reveals secondary fields when SUBMIT_CLICKED with no url", () => {
    const actor = createActor(addFormMachine).start();
    actor.send({ type: "SUBMIT_CLICKED", url: "" });
    expect(actor.getSnapshot().context.showSecondaryFields).toBe(true);
    expect(actor.getSnapshot().value).toBe("enteringManually");
  });

  it("does not change state when SUBMIT_CLICKED with a url", () => {
    const actor = createActor(addFormMachine).start();
    actor.send({ type: "SUBMIT_CLICKED", url: "https://example.com/release" });
    expect(actor.getSnapshot().context.showSecondaryFields).toBe(false);
    // Still in idle (submit flow is Task 2)
    expect(actor.getSnapshot().value).toBe("idle");
  });

  it("opens link picker with candidates", () => {
    const actor = createActor(addFormMachine).start();
    const pendingValues = {
      url: "https://example.com",
      title: "",
      artist: "",
      itemType: "album",
      label: "",
      year: "",
      country: "",
      genre: "",
      catalogueNumber: "",
      notes: "",
      artworkUrl: "",
    };
    actor.send({
      type: "LINK_PICKER_OPENED",
      url: "https://example.com",
      message: "Pick one",
      candidates: [{ candidateId: "a", title: "Release A", artist: "Artist", itemType: "album" }],
      pendingValues,
    });
    const ctx = actor.getSnapshot().context;
    expect(actor.getSnapshot().value).toBe("linkPickerOpen");
    expect(ctx.linkPicker?.candidates).toHaveLength(1);
    expect(ctx.linkPicker?.selectedCandidateId).toBeNull();
  });

  it("selects a link picker candidate", () => {
    const actor = createActor(addFormMachine).start();
    const pendingValues = {
      url: "https://example.com",
      title: "",
      artist: "",
      itemType: "album",
      label: "",
      year: "",
      country: "",
      genre: "",
      catalogueNumber: "",
      notes: "",
      artworkUrl: "",
    };
    actor.send({
      type: "LINK_PICKER_OPENED",
      url: "https://example.com",
      message: "Pick one",
      candidates: [{ candidateId: "a", title: "Release A", artist: "Artist", itemType: "album" }],
      pendingValues,
    });
    actor.send({ type: "CANDIDATE_SELECTED", candidateId: "a" });
    expect(actor.getSnapshot().context.linkPicker?.selectedCandidateId).toBe("a");
  });

  it("cancels link picker and returns to idle", () => {
    const actor = createActor(addFormMachine).start();
    const pendingValues = {
      url: "https://example.com",
      title: "",
      artist: "",
      itemType: "album",
      label: "",
      year: "",
      country: "",
      genre: "",
      catalogueNumber: "",
      notes: "",
      artworkUrl: "",
    };
    actor.send({
      type: "LINK_PICKER_OPENED",
      url: "https://example.com",
      message: "Pick one",
      candidates: [],
      pendingValues,
    });
    actor.send({ type: "LINK_PICKER_CANCELLED" });
    expect(actor.getSnapshot().value).toBe("idle");
    expect(actor.getSnapshot().context.linkPicker).toBeNull();
  });

  it("enter manually from link picker sets showSecondaryFields and goes to enteringManually", () => {
    const actor = createActor(addFormMachine).start();
    const pendingValues = {
      url: "https://example.com",
      title: "",
      artist: "",
      itemType: "album",
      label: "",
      year: "",
      country: "",
      genre: "",
      catalogueNumber: "",
      notes: "",
      artworkUrl: "",
    };
    actor.send({
      type: "LINK_PICKER_OPENED",
      url: "https://example.com",
      message: "Pick one",
      candidates: [],
      pendingValues,
    });
    actor.send({ type: "ENTER_MANUALLY" });
    expect(actor.getSnapshot().value).toBe("enteringManually");
    expect(actor.getSnapshot().context.showSecondaryFields).toBe(true);
    expect(actor.getSnapshot().context.linkPicker).toBeNull();
  });

  it("FORM_RESET returns to idle and clears fields", () => {
    const actor = createActor(addFormMachine).start();
    actor.send({ type: "SUBMIT_CLICKED", url: "" });
    expect(actor.getSnapshot().value).toBe("enteringManually");
    actor.send({ type: "FORM_RESET" });
    expect(actor.getSnapshot().value).toBe("idle");
    expect(actor.getSnapshot().context.showSecondaryFields).toBe(false);
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

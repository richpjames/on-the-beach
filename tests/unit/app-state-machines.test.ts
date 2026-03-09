import { createActor, waitFor } from "xstate";
import { describe, expect, it } from "bun:test";

import { addFormMachine } from "../../src/ui/state/add-form-machine";
import { appMachine } from "../../src/ui/state/app-machine";
import {
  initialRatingState,
  resolveRatingClick,
  transitionRatingState,
} from "../../src/ui/state/rating-machine";

function makeMockApi(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    createMusicItem: async () => ({
      id: 42,
      title: "Test",
      artist: "Artist",
      itemType: "album",
      listenStatus: "to-listen",
      createdAt: "",
      updatedAt: "",
    }),
    lookupRelease: async () => ({}),
    setItemStacks: async () => {},
    listStacks: async () => [],
    ...overrides,
  };
}

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
    const actor = createActor(addFormMachine, { input: { api: makeMockApi() as any } }).start();

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
    const actor = createActor(addFormMachine, { input: { api: makeMockApi() as any } }).start();

    actor.send({ type: "SCAN_STARTED" });
    expect(actor.getSnapshot().context.scanState).toBe("scanning");

    actor.send({ type: "SCAN_FINISHED" });
    expect(actor.getSnapshot().context.scanState).toBe("idle");
  });

  it("tracks submit loading state", () => {
    const actor = createActor(addFormMachine, { input: { api: makeMockApi() as any } }).start();

    expect(actor.getSnapshot().context.submitState).toBe("idle");

    actor.send({ type: "SUBMIT_STARTED" });
    expect(actor.getSnapshot().context.submitState).toBe("submitting");

    actor.send({ type: "SUBMIT_FINISHED" });
    expect(actor.getSnapshot().context.submitState).toBe("idle");
  });

  it("tracks submit error state", () => {
    const actor = createActor(addFormMachine, { input: { api: makeMockApi() as any } }).start();

    actor.send({ type: "SUBMIT_STARTED" });
    actor.send({ type: "SUBMIT_ERROR" });
    expect(actor.getSnapshot().context.submitState).toBe("error");

    actor.send({ type: "SUBMIT_FINISHED" });
    expect(actor.getSnapshot().context.submitState).toBe("idle");
  });
});

describe("add form machine — secondary fields and link picker", () => {
  it("reveals secondary fields when SUBMIT_CLICKED with no url", () => {
    const actor = createActor(addFormMachine, { input: { api: makeMockApi() as any } }).start();
    actor.send({ type: "SUBMIT_CLICKED", url: "" });
    expect(actor.getSnapshot().context.showSecondaryFields).toBe(true);
    expect(actor.getSnapshot().value).toBe("enteringManually");
  });

  it("transitions to submitting when SUBMIT_CLICKED with a url", () => {
    const actor = createActor(addFormMachine, { input: { api: makeMockApi() as any } }).start();
    actor.send({ type: "SUBMIT_CLICKED", url: "https://example.com/release" });
    expect(actor.getSnapshot().context.showSecondaryFields).toBe(false);
    // Now transitions to submitting (Task 2 implemented)
    expect(actor.getSnapshot().value).toBe("submitting");
  });

  it("opens link picker with candidates", () => {
    const actor = createActor(addFormMachine, { input: { api: makeMockApi() as any } }).start();
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
    const actor = createActor(addFormMachine, { input: { api: makeMockApi() as any } }).start();
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
    const actor = createActor(addFormMachine, { input: { api: makeMockApi() as any } }).start();
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
    const actor = createActor(addFormMachine, { input: { api: makeMockApi() as any } }).start();
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

  it("FORM_RESET resets submitState to idle", () => {
    const actor = createActor(addFormMachine, { input: { api: makeMockApi() as any } }).start();
    actor.send({ type: "SUBMIT_ERROR" });
    expect(actor.getSnapshot().context.submitState).toBe("error");
    actor.send({ type: "FORM_RESET" });
    expect(actor.getSnapshot().context.submitState).toBe("idle");
  });

  it("LINK_PICKER_CANCELLED from enteringManually path returns to idle (by design)", () => {
    const actor = createActor(addFormMachine, { input: { api: makeMockApi() as any } }).start();
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
    // Enter manually first
    actor.send({ type: "SUBMIT_CLICKED", url: "" });
    expect(actor.getSnapshot().value).toBe("enteringManually");
    // Then open link picker
    actor.send({
      type: "LINK_PICKER_OPENED",
      url: "https://example.com",
      message: "Pick one",
      candidates: [],
      pendingValues,
    });
    expect(actor.getSnapshot().value).toBe("linkPickerOpen");
    // Cancel always goes to idle (by design)
    actor.send({ type: "LINK_PICKER_CANCELLED" });
    expect(actor.getSnapshot().value).toBe("idle");
  });

  it("FORM_RESET returns to idle and clears fields", () => {
    const actor = createActor(addFormMachine, { input: { api: makeMockApi() as any } }).start();
    actor.send({ type: "SUBMIT_CLICKED", url: "" });
    expect(actor.getSnapshot().value).toBe("enteringManually");
    actor.send({ type: "FORM_RESET" });
    expect(actor.getSnapshot().value).toBe("idle");
    expect(actor.getSnapshot().context.showSecondaryFields).toBe(false);
  });
});

describe("add form machine — async submit flow", () => {
  const pendingValues = {
    url: "https://example.com",
    title: "Test Album",
    artist: "Test Artist",
    itemType: "album",
    label: "",
    year: "",
    country: "",
    genre: "",
    catalogueNumber: "",
    notes: "",
    artworkUrl: "",
  };

  it("transitions through submitting to idle on success, sets createdItemId", async () => {
    const api = makeMockApi() as any;
    const actor = createActor(addFormMachine, { input: { api } }).start();

    actor.send({ type: "SUBMIT_CLICKED", url: "https://example.com", pendingValues });

    expect(actor.getSnapshot().value).toBe("submitting");

    await waitFor(actor, (snapshot) => snapshot.value !== "submitting", { timeout: 5000 });

    expect(actor.getSnapshot().value).toBe("idle");
    expect(actor.getSnapshot().context.createdItemId).toBe(42);
    expect(actor.getSnapshot().context.submitState).toBe("idle");
    expect(actor.getSnapshot().context.showSecondaryFields).toBe(false);
    expect(actor.getSnapshot().context.selectedStackIds).toEqual([]);
  });

  it("transitions to linkPickerOpen on AmbiguousLinkApiError", async () => {
    const { AmbiguousLinkApiError } = await import("../../src/services/api-client");
    const api = makeMockApi({
      createMusicItem: async () => {
        throw new AmbiguousLinkApiError({
          url: "https://x.com",
          message: "Pick one",
          candidates: [
            { candidateId: "a", title: "Release A", artist: "Artist", itemType: "album" },
          ],
        });
      },
    }) as any;
    const actor = createActor(addFormMachine, { input: { api } }).start();

    actor.send({ type: "SUBMIT_CLICKED", url: "https://example.com", pendingValues });
    await waitFor(actor, (snapshot) => snapshot.value !== "submitting", { timeout: 5000 });

    expect(actor.getSnapshot().value).toBe("linkPickerOpen");
    expect(actor.getSnapshot().context.linkPicker?.message).toBe("Pick one");
    expect(actor.getSnapshot().context.linkPicker?.candidates).toHaveLength(1);
  });

  it("transitions to idle with error submitState on unexpected error", async () => {
    const api = makeMockApi({
      createMusicItem: async () => {
        throw new Error("Network error");
      },
    }) as any;
    const actor = createActor(addFormMachine, { input: { api } }).start();

    actor.send({ type: "SUBMIT_CLICKED", url: "https://example.com", pendingValues });
    await waitFor(actor, (snapshot) => snapshot.value !== "submitting", { timeout: 5000 });

    expect(actor.getSnapshot().value).toBe("idle");
    expect(actor.getSnapshot().context.submitState).toBe("error");
  });

  it("submits from enteringManually state", async () => {
    const api = makeMockApi() as any;
    const actor = createActor(addFormMachine, { input: { api } }).start();

    actor.send({ type: "SUBMIT_CLICKED", url: "" });
    expect(actor.getSnapshot().value).toBe("enteringManually");

    actor.send({ type: "SUBMIT_CLICKED", url: "", pendingValues });
    expect(actor.getSnapshot().value).toBe("submitting");

    await waitFor(actor, (snapshot) => snapshot.value !== "submitting", { timeout: 5000 });
    expect(actor.getSnapshot().value).toBe("idle");
    expect(actor.getSnapshot().context.createdItemId).toBe(42);
  });

  it("ignores SUBMIT_CLICKED from enteringManually when pendingValues is absent", () => {
    const api = makeMockApi() as any;
    const actor = createActor(addFormMachine, { input: { api } }).start();
    actor.send({ type: "SUBMIT_CLICKED", url: "" }); // go to enteringManually
    expect(actor.getSnapshot().value).toBe("enteringManually");
    actor.send({ type: "SUBMIT_CLICKED", url: "" }); // no pendingValues — should be ignored
    expect(actor.getSnapshot().value).toBe("enteringManually"); // stays in enteringManually
  });

  it("submits selected candidate from link picker", async () => {
    const { AmbiguousLinkApiError } = await import("../../src/services/api-client");
    let callCount = 0;
    const api = makeMockApi({
      createMusicItem: async () => {
        callCount++;
        if (callCount === 1) {
          throw new AmbiguousLinkApiError({
            url: "https://x.com",
            message: "Pick one",
            candidates: [
              { candidateId: "a", title: "Release A", artist: "Artist", itemType: "album" },
            ],
          });
        }
        return {
          id: 99,
          title: "Release A",
          artist: "Artist",
          itemType: "album",
          listenStatus: "to-listen",
          createdAt: "",
          updatedAt: "",
        };
      },
    }) as any;
    const actor = createActor(addFormMachine, { input: { api } }).start();

    actor.send({ type: "SUBMIT_CLICKED", url: "https://example.com", pendingValues });
    await waitFor(actor, (snapshot) => snapshot.value !== "submitting", { timeout: 5000 });
    expect(actor.getSnapshot().value).toBe("linkPickerOpen");

    actor.send({ type: "CANDIDATE_SELECTED", candidateId: "a" });
    actor.send({ type: "CANDIDATE_SUBMITTED" });
    expect(actor.getSnapshot().value).toBe("submitting");

    await waitFor(actor, (snapshot) => snapshot.value !== "submitting", { timeout: 5000 });
    expect(actor.getSnapshot().value).toBe("idle");
    expect(actor.getSnapshot().context.createdItemId).toBe(99);
  });
});

describe("add form machine — scan flow", () => {
  it("transitions to scanning state on SCAN_FILE_SELECTED", async () => {
    const api = makeMockApi({
      uploadReleaseImage: async () => ({ artworkUrl: "https://cdn.example.com/art.jpg" }),
      scanCover: async () => ({ artist: "Scanned Artist", title: "Scanned Title" }),
    }) as any;
    const actor = createActor(addFormMachine, { input: { api } }).start();

    actor.send({ type: "SCAN_FILE_SELECTED", imageBase64: "base64data" });
    expect(actor.getSnapshot().value).toBe("scanning");
    expect(actor.getSnapshot().context.scanState).toBe("scanning");
  });

  it("returns to idle with scan results on success", async () => {
    const { waitFor } = await import("xstate");
    const api = makeMockApi({
      uploadReleaseImage: async () => ({ artworkUrl: "https://cdn.example.com/art.jpg" }),
      scanCover: async () => ({ artist: "Scanned Artist", title: "Scanned Title" }),
    }) as any;
    const actor = createActor(addFormMachine, { input: { api } }).start();

    actor.send({ type: "SCAN_FILE_SELECTED", imageBase64: "base64data" });
    await waitFor(actor, (s) => s.value !== "scanning", { timeout: 5000 });

    const ctx = actor.getSnapshot().context;
    expect(actor.getSnapshot().value).toBe("idle");
    expect(ctx.scanState).toBe("idle");
    expect(ctx.scanResult?.artist).toBe("Scanned Artist");
    expect(ctx.scanResult?.title).toBe("Scanned Title");
    expect(ctx.scanResult?.artworkUrl).toBe("https://cdn.example.com/art.jpg");
  });

  it("returns to idle with scanError on failure", async () => {
    const { waitFor } = await import("xstate");
    const api = makeMockApi({
      uploadReleaseImage: async () => {
        throw new Error("Upload failed");
      },
      scanCover: async () => {
        throw new Error("Scan failed");
      },
    }) as any;
    const actor = createActor(addFormMachine, { input: { api } }).start();

    actor.send({ type: "SCAN_FILE_SELECTED", imageBase64: "base64data" });
    await waitFor(actor, (s) => s.value !== "scanning", { timeout: 5000 });

    const ctx = actor.getSnapshot().context;
    expect(actor.getSnapshot().value).toBe("idle");
    expect(ctx.scanState).toBe("idle");
    expect(ctx.scanResult).toBeNull();
    expect(ctx.scanError).toBeTruthy();
  });

  it("clears scan result on SCAN_RESULT_CONSUMED", async () => {
    const { waitFor } = await import("xstate");
    const api = makeMockApi({
      uploadReleaseImage: async () => ({ artworkUrl: "https://cdn.example.com/art.jpg" }),
      scanCover: async () => ({ artist: "Scanned Artist", title: "Scanned Title" }),
    }) as any;
    const actor = createActor(addFormMachine, { input: { api } }).start();

    actor.send({ type: "SCAN_FILE_SELECTED", imageBase64: "base64data" });
    await waitFor(actor, (s) => s.value !== "scanning", { timeout: 5000 });

    expect(actor.getSnapshot().context.scanResult).not.toBeNull();
    actor.send({ type: "SCAN_RESULT_CONSUMED" });
    expect(actor.getSnapshot().context.scanResult).toBeNull();
    expect(actor.getSnapshot().context.scanError).toBeNull(); // ADD THIS
  });

  it("ignores SCAN_FILE_SELECTED while submitting", () => {
    const api = makeMockApi() as any;
    const actor = createActor(addFormMachine, { input: { api } }).start();
    // Drive to submitting state
    actor.send({
      type: "SUBMIT_CLICKED",
      url: "https://example.com",
      pendingValues: {
        url: "https://example.com",
        title: "Test",
        artist: "Artist",
        itemType: "album",
        label: "",
        year: "",
        country: "",
        genre: "",
        catalogueNumber: "",
        notes: "",
        artworkUrl: "",
      },
    });
    expect(actor.getSnapshot().value).toBe("submitting");
    // Scanning should be ignored while submitting
    actor.send({ type: "SCAN_FILE_SELECTED", imageBase64: "base64" });
    expect(actor.getSnapshot().value).toBe("submitting"); // still submitting, not scanning
  });

  it("FORM_RESET clears scan-related fields", async () => {
    const api = makeMockApi({
      uploadReleaseImage: async () => ({ artworkUrl: "https://cdn.example.com/art.jpg" }),
      scanCover: async () => ({ artist: "Scanned Artist", title: "Scanned Title" }),
    }) as any;
    const actor = createActor(addFormMachine, { input: { api } }).start();

    actor.send({ type: "SCAN_FILE_SELECTED", imageBase64: "base64data" });
    await waitFor(actor, (s) => s.value !== "scanning", { timeout: 5000 });
    expect(actor.getSnapshot().context.scanResult).not.toBeNull();

    actor.send({ type: "FORM_RESET" });
    const ctx = actor.getSnapshot().context;
    expect(ctx.scanResult).toBeNull();
    expect(ctx.scanError).toBeNull();
    expect(ctx.pendingScanBase64).toBeNull();
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

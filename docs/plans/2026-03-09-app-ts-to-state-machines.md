# app.ts → State Machines Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Invert the current controller/passive-store split so the XState machines own all logic and async flows, and `app.ts` becomes a thin DOM adapter (send events in, subscribe and reflect state out).

**Architecture:** Two machines (`appMachine`, `addFormMachine`) gain invoked async actors, new context fields, and proper states. `app.ts` drops all business logic and is restructured into two module-level setup functions — `setupAddForm(actor, appActor)` and `setupAppUI(actor)` — wired via `actor.subscribe()`. The API client is passed as actor `input` at creation time; machines never touch the DOM.

**Tech Stack:** XState 5 (`setup`, `fromPromise`, `assign`, `createActor`), bun:test, TypeScript

---

## Overview of tasks

| # | Task | Machine/File |
|---|------|-------------|
| 1 | Add secondary-fields + link-picker state to `addFormMachine` | `add-form-machine.ts` |
| 2 | Add async submit flow (invoked actor) to `addFormMachine` | `add-form-machine.ts` |
| 3 | Add async scan flow (invoked actor) to `addFormMachine` | `add-form-machine.ts` |
| 4 | Add browse-panel state to `appMachine` | `app-machine.ts` |
| 5 | Add list-refresh mechanism to `appMachine` | `app-machine.ts` |
| 6 | Wire `addFormMachine` in `app.ts` (send + subscribe) | `app.ts` |
| 7 | Wire `appMachine` in `app.ts` (send + subscribe) | `app.ts` |
| 8 | Delete `App` class, replace with module functions | `app.ts` |

---

## Task 1: addFormMachine — secondary fields + link picker context

**Files:**
- Modify: `src/ui/state/add-form-machine.ts`
- Test: `tests/unit/app-state-machines.test.ts`

**Background:** `showSecondaryFields` controls whether the Artist/Release inputs are visible. `linkPickerState` holds the ambiguous-link candidates. Both are currently held as class fields in `app.ts`. Moving them into machine context makes them testable and removes the implicit state from the controller.

**Step 1: Write failing tests**

Add to `tests/unit/app-state-machines.test.ts`:

```typescript
describe("add form machine — secondary fields", () => {
  it("reveals secondary fields when SUBMIT_CLICKED with no url", () => {
    const actor = createActor(addFormMachine).start();
    actor.send({ type: "SUBMIT_CLICKED", url: "" });
    expect(actor.getSnapshot().context.showSecondaryFields).toBe(true);
    expect(actor.getSnapshot().value).toBe("enteringManually");
  });

  it("does not reveal secondary fields when SUBMIT_CLICKED with a url", () => {
    const actor = createActor(addFormMachine).start();
    actor.send({ type: "SUBMIT_CLICKED", url: "https://example.com/release" });
    // stays in idle (submit flow handled in Task 2); fields stay hidden
    expect(actor.getSnapshot().context.showSecondaryFields).toBe(false);
  });

  it("opens link picker with candidates", () => {
    const actor = createActor(addFormMachine).start();
    actor.send({
      type: "LINK_PICKER_OPENED",
      url: "https://example.com",
      message: "Pick one",
      candidates: [{ candidateId: "a", title: "Release A", artist: "Artist", itemType: "album" }],
      pendingValues: { url: "https://example.com", title: "", artist: "", itemType: "album", label: "", year: "", country: "", genre: "", catalogueNumber: "", notes: "", artworkUrl: "" },
    });
    const ctx = actor.getSnapshot().context;
    expect(actor.getSnapshot().value).toBe("linkPickerOpen");
    expect(ctx.linkPicker?.candidates).toHaveLength(1);
    expect(ctx.linkPicker?.selectedCandidateId).toBeNull();
  });

  it("selects a link picker candidate", () => {
    const actor = createActor(addFormMachine).start();
    actor.send({
      type: "LINK_PICKER_OPENED",
      url: "https://example.com",
      message: "Pick one",
      candidates: [{ candidateId: "a", title: "Release A", artist: "Artist", itemType: "album" }],
      pendingValues: { url: "https://example.com", title: "", artist: "", itemType: "album", label: "", year: "", country: "", genre: "", catalogueNumber: "", notes: "", artworkUrl: "" },
    });
    actor.send({ type: "CANDIDATE_SELECTED", candidateId: "a" });
    expect(actor.getSnapshot().context.linkPicker?.selectedCandidateId).toBe("a");
  });

  it("cancels link picker and returns to idle", () => {
    const actor = createActor(addFormMachine).start();
    actor.send({
      type: "LINK_PICKER_OPENED",
      url: "https://example.com",
      message: "Pick one",
      candidates: [],
      pendingValues: { url: "https://example.com", title: "", artist: "", itemType: "album", label: "", year: "", country: "", genre: "", catalogueNumber: "", notes: "", artworkUrl: "" },
    });
    actor.send({ type: "LINK_PICKER_CANCELLED" });
    expect(actor.getSnapshot().value).toBe("idle");
    expect(actor.getSnapshot().context.linkPicker).toBeNull();
  });
});
```

**Step 2: Run to verify failure**

```bash
bun test tests/unit/app-state-machines.test.ts
```
Expected: FAIL — `SUBMIT_CLICKED` not defined, `showSecondaryFields` not in context.

**Step 3: Implement**

Replace `add-form-machine.ts` with `setup()`-based machine. Add new context, events, and states:

```typescript
import { setup, assign } from "xstate";
import type { AddFormValues as AddFormValuesInput } from "../domain/add-form";
import type { LinkReleaseCandidate } from "../../types";

interface LinkPickerContext {
  url: string;
  message: string;
  candidates: LinkReleaseCandidate[];
  selectedCandidateId: string | null;
  pendingValues: AddFormValuesInput;
}

export interface AddFormContext {
  initialized: boolean;
  selectedStackIds: number[];
  scanState: "idle" | "scanning";
  submitState: "idle" | "submitting" | "error";
  showSecondaryFields: boolean;
  linkPicker: LinkPickerContext | null;
}

export type AddFormEvent =
  | { type: "INITIALIZED" }
  | { type: "STACK_TOGGLED"; stackId: number; checked: boolean }
  | { type: "STACK_ADDED"; stackId: number }
  | { type: "STACK_REMOVED"; stackId: number }
  | { type: "CLEAR_STACKS" }
  | { type: "SCAN_STARTED" }
  | { type: "SCAN_FINISHED" }
  | { type: "SUBMIT_STARTED" }
  | { type: "SUBMIT_FINISHED" }
  | { type: "SUBMIT_ERROR" }
  | { type: "SUBMIT_CLICKED"; url: string }
  | { type: "LINK_PICKER_OPENED"; url: string; message: string; candidates: LinkReleaseCandidate[]; pendingValues: AddFormValuesInput }
  | { type: "CANDIDATE_SELECTED"; candidateId: string }
  | { type: "LINK_PICKER_CANCELLED" }
  | { type: "ENTER_MANUALLY" }
  | { type: "FORM_RESET" };

export const addFormMachine = setup({
  types: {} as { context: AddFormContext; events: AddFormEvent },
}).createMachine({
  id: "addForm",
  initial: "idle",
  context: {
    initialized: false,
    selectedStackIds: [],
    scanState: "idle",
    submitState: "idle",
    showSecondaryFields: false,
    linkPicker: null,
  },
  // Global events that work in any state
  on: {
    INITIALIZED: { actions: assign({ initialized: true }) },
    STACK_TOGGLED: {
      actions: assign(({ context, event }) => {
        const exists = context.selectedStackIds.includes(event.stackId);
        if (event.checked && !exists) return { selectedStackIds: [...context.selectedStackIds, event.stackId] };
        if (!event.checked && exists) return { selectedStackIds: context.selectedStackIds.filter((id) => id !== event.stackId) };
        return {};
      }),
    },
    STACK_ADDED: {
      actions: assign(({ context, event }) => {
        if (context.selectedStackIds.includes(event.stackId)) return {};
        return { selectedStackIds: [...context.selectedStackIds, event.stackId] };
      }),
    },
    STACK_REMOVED: {
      actions: assign(({ context, event }) => ({ selectedStackIds: context.selectedStackIds.filter((id) => id !== event.stackId) })),
    },
    CLEAR_STACKS: { actions: assign({ selectedStackIds: [] }) },
    SCAN_STARTED: { actions: assign({ scanState: "scanning" as const }) },
    SCAN_FINISHED: { actions: assign({ scanState: "idle" as const }) },
    SUBMIT_STARTED: { actions: assign({ submitState: "submitting" as const }) },
    SUBMIT_FINISHED: { actions: assign({ submitState: "idle" as const }) },
    SUBMIT_ERROR: { actions: assign({ submitState: "error" as const }) },
    FORM_RESET: { target: ".idle", actions: assign({ showSecondaryFields: false, linkPicker: null }) },
  },
  states: {
    idle: {
      on: {
        SUBMIT_CLICKED: [
          {
            guard: ({ event }) => !event.url.trim(),
            target: "enteringManually",
            actions: assign({ showSecondaryFields: true }),
          },
          // url present — submit flow handled in Task 2; for now no-op
        ],
        LINK_PICKER_OPENED: {
          target: "linkPickerOpen",
          actions: assign(({ event }) => ({
            linkPicker: {
              url: event.url,
              message: event.message,
              candidates: event.candidates,
              selectedCandidateId: null,
              pendingValues: event.pendingValues,
            },
          })),
        },
      },
    },
    enteringManually: {
      on: {
        LINK_PICKER_OPENED: {
          target: "linkPickerOpen",
          actions: assign(({ event }) => ({
            linkPicker: {
              url: event.url,
              message: event.message,
              candidates: event.candidates,
              selectedCandidateId: null,
              pendingValues: event.pendingValues,
            },
          })),
        },
      },
    },
    linkPickerOpen: {
      on: {
        CANDIDATE_SELECTED: {
          actions: assign(({ context, event }) => ({
            linkPicker: context.linkPicker ? { ...context.linkPicker, selectedCandidateId: event.candidateId } : null,
          })),
        },
        LINK_PICKER_CANCELLED: {
          target: "idle",
          actions: assign({ linkPicker: null }),
        },
        ENTER_MANUALLY: {
          target: "enteringManually",
          actions: assign({ showSecondaryFields: true, linkPicker: null }),
        },
      },
    },
  },
});
```

**Step 4: Run tests**

```bash
bun test tests/unit/app-state-machines.test.ts
```
Expected: All tests pass.

**Step 5: Commit**

```bash
git add src/ui/state/add-form-machine.ts tests/unit/app-state-machines.test.ts
git commit -m "feat: add secondary fields and link picker state to addFormMachine"
```

---

## Task 2: addFormMachine — async submit flow

**Files:**
- Modify: `src/ui/state/add-form-machine.ts`
- Modify: `src/services/api-client.ts` (read to understand interface)
- Test: `tests/unit/app-state-machines.test.ts`

**Background:** The submit flow (`enrichValuesWithMusicBrainz` → `api.createMusicItem` → `handleCreatedItem`) is currently imperative in `app.ts`. Moving it into a `submitting` state with an invoked actor makes the happy path, ambiguous-link path, and error path all explicit and testable.

The machine needs the API client. Pass it as actor `input`:
```typescript
createActor(addFormMachine, { input: { api } }).start()
```

**Step 1: Read the API client interface**

Read `src/services/api-client.ts` to confirm method signatures for `lookupRelease`, `createMusicItem`, `setItemStacks`.

**Step 2: Write failing tests**

Add to the `describe("add form machine")` block in `tests/unit/app-state-machines.test.ts`:

```typescript
import type { ApiClient } from "../../src/services/api-client";

function makeMockApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    createMusicItem: async () => ({ id: 42, title: "Test", artist: "Artist", itemType: "album", listenStatus: "to-listen", createdAt: "", updatedAt: "" }),
    lookupRelease: async () => ({}),
    setItemStacks: async () => {},
    listStacks: async () => [],
    // ... other methods as no-ops
    ...overrides,
  } as unknown as ApiClient;
}

describe("add form machine — submit flow", () => {
  it("transitions through submitting to success", async () => {
    const api = makeMockApi();
    const actor = createActor(addFormMachine, { input: { api } }).start();

    const pendingValues = { url: "https://example.com", title: "Test", artist: "Artist", itemType: "album", label: "", year: "", country: "", genre: "", catalogueNumber: "", notes: "", artworkUrl: "" };
    actor.send({ type: "SUBMIT_CLICKED", url: "https://example.com", pendingValues });

    // Wait for async actor
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(actor.getSnapshot().value).toBe("idle");
    expect(actor.getSnapshot().context.submitState).toBe("idle");
  });

  it("transitions to linkPickerOpen when API throws AmbiguousLinkApiError", async () => {
    const { AmbiguousLinkApiError } = await import("../../src/services/api-client");
    const api = makeMockApi({
      createMusicItem: async () => {
        throw new AmbiguousLinkApiError({ url: "https://x.com", message: "Pick one", candidates: [] });
      },
    });
    const actor = createActor(addFormMachine, { input: { api } }).start();

    const pendingValues = { url: "https://example.com", title: "", artist: "", itemType: "album", label: "", year: "", country: "", genre: "", catalogueNumber: "", notes: "", artworkUrl: "" };
    actor.send({ type: "SUBMIT_CLICKED", url: "https://example.com", pendingValues });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(actor.getSnapshot().value).toBe("linkPickerOpen");
    expect(actor.getSnapshot().context.linkPicker?.message).toBe("Pick one");
  });
});
```

**Step 3: Run to verify failure**

```bash
bun test tests/unit/app-state-machines.test.ts
```
Expected: FAIL — `submitting` state doesn't exist yet, `input` not accepted.

**Step 4: Implement**

1. Update machine to accept `input`:

```typescript
export const addFormMachine = setup({
  types: {} as {
    context: AddFormContext;
    events: AddFormEvent;
    input: { api: ApiClient };
  },
  actors: {
    submitItem: fromPromise<{ itemId: number }, { api: ApiClient; values: AddFormValuesInput; selectedCandidateId?: string; selectedStackIds: number[] }>(
      async ({ input }) => {
        const { api, values, selectedCandidateId, selectedStackIds } = input;

        // Enrich with MusicBrainz
        let enrichedValues = { ...values };
        let musicbrainzReleaseId: string | undefined;
        let musicbrainzArtistId: string | undefined;

        if (values.artist.trim() && values.title.trim()) {
          try {
            const enrichment = await api.lookupRelease(values.artist.trim(), values.title.trim(), values.year.trim() || undefined);
            if (enrichment.year != null && !values.year.trim()) enrichedValues.year = String(enrichment.year);
            if (enrichment.label && !values.label.trim()) enrichedValues.label = enrichment.label;
            if (enrichment.country && !values.country.trim()) enrichedValues.country = enrichment.country;
            if (enrichment.catalogueNumber && !values.catalogueNumber.trim()) enrichedValues.catalogueNumber = enrichment.catalogueNumber;
            if (enrichment.artworkUrl && !values.artworkUrl.trim()) enrichedValues.artworkUrl = enrichment.artworkUrl;
            if (enrichment.musicbrainzReleaseId) musicbrainzReleaseId = enrichment.musicbrainzReleaseId;
            if (enrichment.musicbrainzArtistId) musicbrainzArtistId = enrichment.musicbrainzArtistId;
          } catch {
            // non-fatal
          }
        }

        const item = await api.createMusicItem({
          ...buildCreateMusicItemInputFromValues(enrichedValues),
          listenStatus: "to-listen",
          musicbrainzReleaseId,
          musicbrainzArtistId,
          selectedCandidateId,
        });

        if (selectedStackIds.length > 0) {
          await api.setItemStacks(item.id, selectedStackIds);
        }

        return { itemId: item.id };
      }
    ),
  },
}).createMachine({
  // ...
  context: ({ input }) => ({
    api: input.api,
    initialized: false,
    selectedStackIds: [],
    scanState: "idle" as const,
    submitState: "idle" as const,
    showSecondaryFields: false,
    linkPicker: null,
    pendingValues: null as AddFormValuesInput | null,
  }),
  // ...
  states: {
    idle: {
      on: {
        SUBMIT_CLICKED: [
          {
            guard: ({ event }) => !event.url.trim(),
            target: "enteringManually",
            actions: assign({ showSecondaryFields: true }),
          },
          {
            target: "submitting",
            actions: assign(({ event }) => ({ pendingValues: event.pendingValues, submitState: "submitting" as const })),
          },
        ],
      },
    },
    submitting: {
      invoke: {
        src: "submitItem",
        input: ({ context }) => ({
          api: context.api,
          values: context.pendingValues!,
          selectedStackIds: context.selectedStackIds,
        }),
        onDone: {
          target: "success",
          actions: assign({ submitState: "idle" as const, createdItemId: ({ event }) => event.output.itemId }),
        },
        onError: [
          {
            guard: ({ event }) => event.error instanceof AmbiguousLinkApiError,
            target: "linkPickerOpen",
            actions: assign(({ event, context }) => ({
              submitState: "idle" as const,
              linkPicker: {
                url: (event.error as AmbiguousLinkApiError).payload.url,
                message: (event.error as AmbiguousLinkApiError).payload.message,
                candidates: (event.error as AmbiguousLinkApiError).payload.candidates,
                selectedCandidateId: null,
                pendingValues: context.pendingValues!,
              },
            })),
          },
          {
            target: "error",
            actions: assign({ submitState: "error" as const }),
          },
        ],
      },
    },
    success: {
      // Immediately transition back to idle — app.ts subscribe reacts and resets form + re-renders list
      always: {
        target: "idle",
        actions: assign({ showSecondaryFields: false, selectedStackIds: [], pendingValues: null }),
      },
    },
    error: {
      on: {
        SUBMIT_CLICKED: { target: "submitting" },
      },
    },
    // ...existing enteringManually and linkPickerOpen states
  },
});
```

2. Update `SUBMIT_CLICKED` event type to include `pendingValues`:
```typescript
| { type: "SUBMIT_CLICKED"; url: string; pendingValues: AddFormValuesInput }
```

3. Update `linkPickerOpen` to handle `CANDIDATE_SUBMITTED`:
```typescript
CANDIDATE_SUBMITTED: {
  target: "submitting",
  actions: assign(({ context, event }) => {
    const candidate = context.linkPicker?.candidates.find(c => c.candidateId === context.linkPicker?.selectedCandidateId);
    return {
      submitState: "submitting" as const,
      pendingValues: candidate ? {
        ...context.linkPicker!.pendingValues,
        artist: candidate.artist ?? context.linkPicker!.pendingValues.artist,
        title: candidate.title || context.linkPicker!.pendingValues.title,
        itemType: candidate.itemType ?? context.linkPicker!.pendingValues.itemType,
      } : context.linkPicker!.pendingValues,
      linkPicker: null,
    };
  }),
},
```

**Step 5: Run tests**

```bash
bun test tests/unit/app-state-machines.test.ts
```
Expected: All pass.

**Step 6: Commit**

```bash
git add src/ui/state/add-form-machine.ts tests/unit/app-state-machines.test.ts
git commit -m "feat: add async submit flow to addFormMachine"
```

---

## Task 3: addFormMachine — async scan flow

**Files:**
- Modify: `src/ui/state/add-form-machine.ts`
- Test: `tests/unit/app-state-machines.test.ts`

**Background:** `handleCoverScan` in `app.ts` encodes the image, uploads it, then calls the AI scan. This becomes a `scanning` state with an invoked actor, with results surfaced through context so `app.ts` can populate the form fields via subscription.

**Step 1: Write failing tests**

```typescript
describe("add form machine — scan flow", () => {
  it("transitions to scanning and back to idle on success", async () => {
    const api = makeMockApi({
      uploadReleaseImage: async () => ({ artworkUrl: "https://cdn.example.com/art.jpg" }),
      scanCover: async () => ({ artist: "Scanned Artist", title: "Scanned Title" }),
    });
    const actor = createActor(addFormMachine, { input: { api } }).start();

    actor.send({ type: "SCAN_FILE_SELECTED", imageBase64: "base64data" });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const ctx = actor.getSnapshot().context;
    expect(actor.getSnapshot().value).toBe("idle");
    expect(ctx.scanResult?.artist).toBe("Scanned Artist");
    expect(ctx.scanResult?.artworkUrl).toBe("https://cdn.example.com/art.jpg");
  });
});
```

**Step 2: Run to verify failure**

```bash
bun test tests/unit/app-state-machines.test.ts
```

**Step 3: Implement**

Add `scanResult` to context and a `scanning` state with invoked actor:

```typescript
// In context
scanResult: null as { artist?: string; title?: string; artworkUrl?: string } | null,

// New event
| { type: "SCAN_FILE_SELECTED"; imageBase64: string }

// New actor in setup()
scanCover: fromPromise<{ artist?: string; title?: string; artworkUrl?: string }, { api: ApiClient; imageBase64: string }>(
  async ({ input }) => {
    const { api, imageBase64 } = input;
    const [uploadResult, scanResult] = await Promise.all([
      api.uploadReleaseImage(imageBase64),
      api.scanCover(imageBase64),
    ]);
    return { artworkUrl: uploadResult.artworkUrl, artist: scanResult.artist, title: scanResult.title };
  }
),

// New state
scanning: {
  entry: assign({ scanState: "scanning" as const }),
  exit: assign({ scanState: "idle" as const }),
  invoke: {
    src: "scanCover",
    input: ({ context }) => ({ api: context.api, imageBase64: context.pendingScanBase64! }),
    onDone: {
      target: "idle",
      actions: assign({ scanResult: ({ event }) => event.output }),
    },
    onError: {
      target: "idle",
      actions: assign({ scanError: ({ event }) => String(event.error) }),
    },
  },
},
```

Note: `encodeScanImage` (canvas resize) stays in `app.ts` as a pure DOM utility — the machine receives the already-encoded base64 string.

**Step 4: Run tests**

```bash
bun test tests/unit/app-state-machines.test.ts
```

**Step 5: Commit**

```bash
git add src/ui/state/add-form-machine.ts tests/unit/app-state-machines.test.ts
git commit -m "feat: add async scan flow to addFormMachine"
```

---

## Task 4: appMachine — browse panel state

**Files:**
- Modify: `src/ui/state/app-machine.ts`
- Test: `tests/unit/app-state-machines.test.ts`

**Background:** Browse panel open/close is currently imperative class-toggling in `setupBrowseControls`. Moving it into `appMachine` makes the mutual-exclusion logic (opening one panel closes the other) explicit and testable.

**Step 1: Write failing tests**

```typescript
describe("app machine — browse panels", () => {
  it("opens search panel and closes sort panel", () => {
    const actor = createActor(appMachine).start();
    actor.send({ type: "SORT_PANEL_TOGGLED" });
    actor.send({ type: "SEARCH_PANEL_TOGGLED" });
    const ctx = actor.getSnapshot().context;
    expect(ctx.searchPanelOpen).toBe(true);
    expect(ctx.sortPanelOpen).toBe(false);
  });

  it("closes all panels on BROWSE_PANELS_CLOSED", () => {
    const actor = createActor(appMachine).start();
    actor.send({ type: "SEARCH_PANEL_TOGGLED" });
    actor.send({ type: "BROWSE_PANELS_CLOSED" });
    expect(actor.getSnapshot().context.searchPanelOpen).toBe(false);
  });

  it("toggles a panel off when sent a second time", () => {
    const actor = createActor(appMachine).start();
    actor.send({ type: "SEARCH_PANEL_TOGGLED" });
    actor.send({ type: "SEARCH_PANEL_TOGGLED" });
    expect(actor.getSnapshot().context.searchPanelOpen).toBe(false);
  });
});
```

**Step 2: Run to verify failure**

```bash
bun test tests/unit/app-state-machines.test.ts
```

**Step 3: Implement**

Add to `AppContext`:
```typescript
searchPanelOpen: boolean;
sortPanelOpen: boolean;
```

Add to `AppEvent`:
```typescript
| { type: "SEARCH_PANEL_TOGGLED" }
| { type: "SORT_PANEL_TOGGLED" }
| { type: "BROWSE_PANELS_CLOSED" }
```

Add to `appMachine.on`:
```typescript
SEARCH_PANEL_TOGGLED: {
  actions: assign(({ context }) => ({
    searchPanelOpen: !context.searchPanelOpen,
    sortPanelOpen: false,
  })),
},
SORT_PANEL_TOGGLED: {
  actions: assign(({ context }) => ({
    sortPanelOpen: !context.sortPanelOpen,
    searchPanelOpen: false,
  })),
},
BROWSE_PANELS_CLOSED: {
  actions: assign({ searchPanelOpen: false, sortPanelOpen: false }),
},
```

**Step 4: Run tests**

```bash
bun test tests/unit/app-state-machines.test.ts
```

**Step 5: Commit**

```bash
git add src/ui/state/app-machine.ts tests/unit/app-state-machines.test.ts
git commit -m "feat: add browse panel state to appMachine"
```

---

## Task 5: appMachine — list refresh mechanism

**Files:**
- Modify: `src/ui/state/app-machine.ts`
- Test: `tests/unit/app-state-machines.test.ts`

**Background:** `renderMusicList` and `renderStackBar` are triggered imperatively in ~12 places. The machine needs a way to signal that data has changed and a refresh is needed. The approach: add a `listVersion` counter to context. Any time the machine transitions due to a filter/stack/sort/search/stack-mutation change, it increments `listVersion`. `app.ts` subscribes and re-renders whenever `listVersion` changes.

**Step 1: Write failing tests**

```typescript
describe("app machine — list version", () => {
  it("increments listVersion on filter change", () => {
    const actor = createActor(appMachine).start();
    const v0 = actor.getSnapshot().context.listVersion;
    actor.send({ type: "FILTER_SELECTED", filter: "listened" });
    expect(actor.getSnapshot().context.listVersion).toBe(v0 + 1);
  });

  it("increments listVersion on stack selection", () => {
    const actor = createActor(appMachine).start();
    const v0 = actor.getSnapshot().context.listVersion;
    actor.send({ type: "STACK_SELECTED", stackId: 1 });
    expect(actor.getSnapshot().context.listVersion).toBe(v0 + 1);
  });

  it("increments listVersion on search update", () => {
    const actor = createActor(appMachine).start();
    const v0 = actor.getSnapshot().context.listVersion;
    actor.send({ type: "SEARCH_UPDATED", query: "dub" });
    expect(actor.getSnapshot().context.listVersion).toBe(v0 + 1);
  });

  it("increments listVersion on ITEM_CREATED", () => {
    const actor = createActor(appMachine).start();
    const v0 = actor.getSnapshot().context.listVersion;
    actor.send({ type: "ITEM_CREATED" });
    expect(actor.getSnapshot().context.listVersion).toBe(v0 + 1);
  });
});
```

**Step 2: Run to verify failure**

```bash
bun test tests/unit/app-state-machines.test.ts
```

**Step 3: Implement**

Add to `AppContext`:
```typescript
listVersion: number;
stackBarVersion: number;
```

Add to `AppEvent`:
```typescript
| { type: "ITEM_CREATED" }
```

Update relevant handlers to also increment the version:
```typescript
FILTER_SELECTED: {
  actions: assign(({ context, event }) => ({
    currentFilter: event.filter,
    listVersion: context.listVersion + 1,
  })),
},
STACK_SELECTED: {
  actions: assign(({ context, event }) => ({
    currentStack: event.stackId,
    listVersion: context.listVersion + 1,
    stackBarVersion: context.stackBarVersion + 1,
  })),
},
STACK_SELECTED_ALL: {
  actions: assign(({ context }) => ({
    currentStack: null,
    listVersion: context.listVersion + 1,
    stackBarVersion: context.stackBarVersion + 1,
  })),
},
SEARCH_UPDATED: {
  actions: assign(({ context, event }) => ({
    searchQuery: event.query,
    listVersion: context.listVersion + 1,
    stackBarVersion: context.stackBarVersion + 1,
  })),
},
SORT_UPDATED: {
  actions: assign(({ context, event }) => ({
    currentSort: event.sort,
    listVersion: context.listVersion + 1,
  })),
},
STACK_DELETED: {
  actions: assign(({ context, event }) => ({
    currentStack: context.currentStack === event.stackId ? null : context.currentStack,
    stacks: context.stacks.filter((stack) => stack.id !== event.stackId),
    listVersion: context.listVersion + 1,
    stackBarVersion: context.stackBarVersion + 1,
  })),
},
ITEM_CREATED: {
  actions: assign(({ context }) => ({
    listVersion: context.listVersion + 1,
    stackBarVersion: context.stackBarVersion + 1,
  })),
},
```

Default values: `listVersion: 0, stackBarVersion: 0`.

**Step 4: Run tests**

```bash
bun test tests/unit/app-state-machines.test.ts
```

**Step 5: Commit**

```bash
git add src/ui/state/app-machine.ts tests/unit/app-state-machines.test.ts
git commit -m "feat: add list/stackBar version counters to appMachine"
```

---

## Task 6: Wire addFormMachine in app.ts

**Files:**
- Modify: `src/app.ts`

**Background:** This is the first big wiring step. Replace the imperative logic in `setupAddForm`, `setupLinkPicker`, `handleCoverScan`, `createItemFromValues`, `handleCreatedItem`, `setSubmitButtonState`, `setScanButtonState` with `actor.send()` calls and a single `actor.subscribe()` that syncs DOM state.

**Step 1: Pass API client as actor input**

Change the actor construction in `app.ts`:
```typescript
// Before
private addFormActor = createActor(addFormMachine).start();

// After
private addFormActor = createActor(addFormMachine, { input: { api: this.api } }).start();
```

Note: `this.api` must be initialized before the actor. Move `this.api = new ApiClient()` before the field initializers, or initialize the actor in `initialize()`.

**Step 2: Add subscribe for DOM sync**

In `setupAddForm()`, after acquiring DOM refs, add:

```typescript
this.addFormActor.subscribe((snapshot) => {
  const ctx = snapshot.context;
  const form = document.getElementById("add-form") as HTMLFormElement | null;
  if (!form) return;

  // Secondary fields visibility
  const secondary = form.querySelector<HTMLElement>(".add-form__secondary");
  if (secondary) secondary.hidden = !ctx.showSecondaryFields;

  // Submit button state
  const submitBtn = document.getElementById("add-form-submit") as HTMLButtonElement | null;
  if (submitBtn) {
    submitBtn.disabled = ctx.submitState === "submitting";
    submitBtn.textContent = ctx.submitState === "submitting" ? "Adding..." : "Add";
  }

  // Loading overlay
  const overlay = document.getElementById("add-loading-overlay");
  const isSubmitting = ctx.submitState === "submitting";
  overlay?.classList.toggle("is-visible", isSubmitting);
  overlay?.setAttribute("aria-hidden", isSubmitting ? "false" : "true");

  // Scan button state
  const scanBtn = document.getElementById("add-form-scan-btn") as HTMLButtonElement | null;
  if (scanBtn) {
    scanBtn.disabled = ctx.scanState === "scanning";
    scanBtn.classList.toggle("is-loading", ctx.scanState === "scanning");
    scanBtn.textContent = ctx.scanState === "scanning" ? "Scanning..." : "Scan";
  }

  // Scan results — populate form fields
  if (ctx.scanResult) {
    const artistInput = form.querySelector<HTMLInputElement>('input[name="artist"]');
    const titleInput = form.querySelector<HTMLInputElement>('input[name="title"]');
    const artworkInput = form.querySelector<HTMLInputElement>('input[name="artworkUrl"]');
    if (artistInput && ctx.scanResult.artist) {
      artistInput.value = ctx.scanResult.artist;
      artistInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (titleInput && ctx.scanResult.title) {
      titleInput.value = ctx.scanResult.title;
      titleInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (artworkInput && ctx.scanResult.artworkUrl) {
      artworkInput.value = ctx.scanResult.artworkUrl;
    }
    const detailsEl = form.querySelector<HTMLDetailsElement>(".add-form__details");
    if (detailsEl && (ctx.scanResult.artist || ctx.scanResult.title)) detailsEl.open = true;
    // Clear after consuming
    this.addFormActor.send({ type: "SCAN_RESULT_CONSUMED" });
  }

  // Link picker visibility
  const modal = document.getElementById("link-picker-modal");
  if (modal instanceof HTMLElement) {
    if (snapshot.value === "linkPickerOpen" && ctx.linkPicker) {
      this.renderLinkPickerFromContext(ctx.linkPicker);
    } else {
      modal.hidden = true;
    }
  }

  // On success (machine just transitioned through success → idle): reset form, notify appMachine
  if (snapshot.value === "idle" && ctx.createdItemId != null) {
    form.reset();
    this.renderAddFormStackChips();
    this.appActor.send({ type: "ITEM_CREATED" });
    // Clear createdItemId
    this.addFormActor.send({ type: "CLEAR_CREATED_ITEM" });
  }
});
```

**Step 3: Simplify event handlers to send-only**

Replace `form.addEventListener("submit", ...)`:
```typescript
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!this.appCtx.isReady) {
    alert("App is still loading. Please try again in a moment.");
    return;
  }
  const urlInput = form.querySelector<HTMLInputElement>('input[name="url"]');
  const url = urlInput?.value.trim() ?? "";
  this.addFormActor.send({
    type: "SUBMIT_CLICKED",
    url,
    pendingValues: this.readAddFormValues(new FormData(form)),
  });
});
```

Replace scan file input handler:
```typescript
scanInput.addEventListener("change", async () => {
  const file = scanInput.files?.[0];
  if (!file) return;
  const imageBase64 = await this.encodeScanImage(file);
  this.addFormActor.send({ type: "SCAN_FILE_SELECTED", imageBase64 });
  scanInput.value = "";
});
```

Replace link picker button handlers to send events:
```typescript
submit.addEventListener("click", () => {
  this.addFormActor.send({ type: "CANDIDATE_SUBMITTED" });
});
manual.addEventListener("click", () => {
  const candidate = this.formCtx.linkPicker?.candidates.find(
    c => c.candidateId === this.formCtx.linkPicker?.selectedCandidateId
  );
  if (candidate) this.populateAddFormFromCandidate(candidate);
  this.addFormActor.send({ type: "ENTER_MANUALLY" });
  form.querySelector<HTMLInputElement>('input[name="artist"]')?.focus();
});
cancel.addEventListener("click", () => {
  this.addFormActor.send({ type: "LINK_PICKER_CANCELLED" });
});
```

**Step 4: Delete now-dead methods**

Remove: `createItemFromValues`, `handleCreatedItem`, `enrichValuesWithMusicBrainz`, `setSubmitButtonState`, `setScanButtonState`, `handleCoverScan`, `openLinkPicker`, `closeLinkPicker`, `submitSelectedLinkCandidate`, `enterSelectedCandidateManually`, `findSelectedLinkCandidate`, `buildValuesForSelectedCandidate`.

**Step 5: Run all tests**

```bash
bun test tests/unit
```

**Step 6: Manual smoke test**

Start dev server, add a release via URL, add one manually, test the scan button, test link picker.

**Step 7: Commit**

```bash
git add src/app.ts
git commit -m "refactor: wire addFormMachine as source of truth in app.ts"
```

---

## Task 7: Wire appMachine in app.ts

**Files:**
- Modify: `src/app.ts`

**Background:** `setupFilterBar`, `setupBrowseControls`, `setupStackBar` all contain logic that now belongs in the machine. Replace with send calls and a subscribe that re-renders via version counters.

**Step 1: Add subscribe for appMachine**

In `initializeUI()`, add:

```typescript
let prevListVersion = -1;
let prevStackBarVersion = -1;

this.appActor.subscribe((snapshot) => {
  const ctx = snapshot.context;

  // Browse panels
  const searchPanel = document.getElementById("browse-search-panel");
  const sortPanel = document.getElementById("browse-sort-panel");
  const searchToggle = document.getElementById("browse-search-toggle");
  const sortToggle = document.getElementById("browse-sort-toggle");
  searchPanel?.classList.toggle("is-open", ctx.searchPanelOpen);
  sortPanel?.classList.toggle("is-open", ctx.sortPanelOpen);
  searchToggle?.setAttribute("aria-expanded", String(ctx.searchPanelOpen));
  sortToggle?.setAttribute("aria-expanded", String(ctx.sortPanelOpen));

  // Re-render list when version increments
  if (ctx.listVersion !== prevListVersion) {
    prevListVersion = ctx.listVersion;
    void this.renderMusicList();
  }
  if (ctx.stackBarVersion !== prevStackBarVersion) {
    prevStackBarVersion = ctx.stackBarVersion;
    void this.renderStackBar();
  }
});
```

**Step 2: Simplify event handlers**

`setupFilterBar` — remove manual class toggling and `renderMusicList` call; just send:
```typescript
this.appActor.send({ type: "FILTER_SELECTED", filter: ... });
// active class is handled by subscribe updating filter bar based on ctx.currentFilter
```

`setupBrowseControls` — remove `toggleBrowsePanel` function; replace with:
```typescript
searchToggle.addEventListener("click", () => {
  this.appActor.send({ type: "SEARCH_PANEL_TOGGLED" });
  if (!this.appCtx.searchPanelOpen && searchInput instanceof HTMLInputElement) {
    requestAnimationFrame(() => searchInput.focus());
  }
});
sortToggle.addEventListener("click", () => {
  this.appActor.send({ type: "SORT_PANEL_TOGGLED" });
});
document.addEventListener("click", (event) => {
  if (!(event.target instanceof HTMLElement) || !(browseTools instanceof HTMLElement)) return;
  if (!browseTools.contains(event.target)) {
    this.appActor.send({ type: "BROWSE_PANELS_CLOSED" });
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") this.appActor.send({ type: "BROWSE_PANELS_CLOSED" });
});
```

Remove `renderMusicList`/`renderStackBar` calls from `setupBrowseControls`, `setupFilterBar`, `setupStackBar`, `deleteStackById` — they now trigger via the version counter subscription.

**Step 3: Run all tests**

```bash
bun test tests/unit
```

**Step 4: Commit**

```bash
git add src/app.ts
git commit -m "refactor: wire appMachine as source of truth in app.ts"
```

---

## Task 8: Delete App class, replace with module functions

**Files:**
- Modify: `src/app.ts`
- Modify: `src/main.ts` (or wherever `new App().initialize()` is called)

**Background:** With all logic in the machines, the `App` class is just a namespace for two setup functions and some scrollbar/reorder utilities. Flatten it to module scope.

**Step 1: Find the entry point**

```bash
grep -r "new App" src/
```

**Step 2: Restructure**

Replace the class with:

```typescript
// Create actors at module scope
const api = new ApiClient();
const appActor = createActor(appMachine).start();
const addFormActor = createActor(addFormMachine, { input: { api } }).start();

export function setupAddForm(): void { /* ... */ }
export function setupAppUI(): void { /* ... */ }

export async function initialize(): Promise<void> {
  setupAddForm();
  setupAppUI();
  appActor.send({ type: "APP_READY" });
  // ... rest of initialize()
}
```

Update the entry point to call `initialize()` instead of `new App().initialize()`.

**Step 3: Run all tests and smoke test**

```bash
bun test tests/unit
```

Start dev server. Verify all interactions work: add form, scan, link picker, filter bar, stack bar, browse search/sort panels.

**Step 4: Commit**

```bash
git add src/app.ts src/main.ts
git commit -m "refactor: replace App class with module-level setup functions"
```

---

## Seams to watch

**API client as input** — `addFormMachine` receives `{ api }` as actor input. Tests mock the API with `makeMockApi()`. Never pass DOM nodes through actor input or context.

**Machine-to-machine communication** — `addFormMachine` success triggers `appActor.send({ type: "ITEM_CREATED" })` from the subscribe callback in `app.ts`. This is the join point between the two machines.

**`encodeScanImage`** — This is a canvas/DOM operation. It stays in `app.ts`. The machine receives the already-encoded base64 string via `SCAN_FILE_SELECTED`.

**Scrollbar and reorder utilities** — `setupCustomListScrollbar`, `setupCustomStackScrollbar`, `setupMusicListReorder` are purely DOM utilities with no business logic. They stay as-is and are not moved into machines.

**Focus management** — After `SUBMIT_CLICKED` with no URL, `app.ts` must focus the artist input. Do this in the subscribe callback when `snapshot.value === "enteringManually"` and `ctx.showSecondaryFields` becomes true.

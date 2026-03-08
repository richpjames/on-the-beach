# XState Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate `add-form-machine.ts` and `app-machine.ts` from hand-rolled reducers to XState v5 actors, and add a submit loading state to the release creation flow.

**Architecture:** Both machines become XState `createMachine` definitions with flat `on` handlers using `assign`. The `App` class swaps its plain state objects for actor refs held via `createActor(machine).start()`. State is read via `actor.getSnapshot().context` and mutated via `actor.send(event)`.

**Tech Stack:** XState v5 (`xstate`), Bun test runner, TypeScript

---

### Task 1: Install XState

**Files:**
- Modify: `package.json`

**Step 1: Install the package**

```bash
bun add xstate
```

**Step 2: Verify it appears in package.json**

```bash
grep '"xstate"' package.json
```

Expected: a line like `"xstate": "^5.x.x"`

**Step 3: Commit**

```bash
git add package.json bun.lockb
git commit -m "chore: add xstate dependency"
```

---

### Task 2: Migrate `add-form-machine.ts` to XState v5

**Files:**
- Modify: `src/ui/state/add-form-machine.ts`

The current file exports `initialAddFormState`, `AddFormState`, `AddFormEvent`, and `transitionAddFormState`. Replace all of this with a `createMachine` definition. Keep the same exported types so call sites change minimally — but export the machine instead of the reducer.

**Step 1: Replace the file contents**

```typescript
import { assign, createMachine } from "xstate";

export interface AddFormContext {
  initialized: boolean;
  selectedStackIds: number[];
  scanState: "idle" | "scanning";
  submitState: "idle" | "submitting" | "error";
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
  | { type: "SUBMIT_ERROR" };

export const addFormMachine = createMachine({
  types: {} as { context: AddFormContext; events: AddFormEvent },
  context: {
    initialized: false,
    selectedStackIds: [],
    scanState: "idle",
    submitState: "idle",
  },
  on: {
    INITIALIZED: {
      actions: assign({ initialized: true }),
    },
    STACK_TOGGLED: {
      actions: assign(({ context, event }) => {
        const exists = context.selectedStackIds.includes(event.stackId);
        if (event.checked && !exists) {
          return { selectedStackIds: [...context.selectedStackIds, event.stackId] };
        }
        if (!event.checked && exists) {
          return { selectedStackIds: context.selectedStackIds.filter((id) => id !== event.stackId) };
        }
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
      actions: assign(({ context, event }) => ({
        selectedStackIds: context.selectedStackIds.filter((id) => id !== event.stackId),
      })),
    },
    CLEAR_STACKS: {
      actions: assign({ selectedStackIds: [] }),
    },
    SCAN_STARTED: {
      actions: assign({ scanState: "scanning" as const }),
    },
    SCAN_FINISHED: {
      actions: assign({ scanState: "idle" as const }),
    },
    SUBMIT_STARTED: {
      actions: assign({ submitState: "submitting" as const }),
    },
    SUBMIT_FINISHED: {
      actions: assign({ submitState: "idle" as const }),
    },
    SUBMIT_ERROR: {
      actions: assign({ submitState: "error" as const }),
    },
  },
});
```

**Step 2: Typecheck**

```bash
bun run typecheck
```

Expected: no errors in `add-form-machine.ts` (there will be errors in `app.ts` — that's fine for now, they'll be fixed in Task 4).

---

### Task 3: Migrate `app-machine.ts` to XState v5

**Files:**
- Modify: `src/ui/state/app-machine.ts`

Same pattern as Task 2. Keep the same event names.

**Step 1: Replace the file contents**

```typescript
import { assign, createMachine } from "xstate";
import type { ListenStatus, MusicItemSort, StackWithCount } from "../../types";

export interface AppContext {
  currentFilter: ListenStatus | "all";
  currentStack: number | null;
  searchQuery: string;
  currentSort: MusicItemSort;
  stacks: StackWithCount[];
  isReady: boolean;
  stackManageOpen: boolean;
}

export type AppEvent =
  | { type: "APP_READY" }
  | { type: "FILTER_SELECTED"; filter: ListenStatus | "all" }
  | { type: "STACK_SELECTED"; stackId: number }
  | { type: "STACK_SELECTED_ALL" }
  | { type: "SEARCH_UPDATED"; query: string }
  | { type: "SORT_UPDATED"; sort: MusicItemSort }
  | { type: "STACKS_LOADED"; stacks: StackWithCount[] }
  | { type: "STACK_MANAGE_TOGGLED" }
  | { type: "STACK_DELETED"; stackId: number };

export const appMachine = createMachine({
  types: {} as { context: AppContext; events: AppEvent },
  context: {
    currentFilter: "to-listen",
    currentStack: null,
    searchQuery: "",
    currentSort: "default",
    stacks: [],
    isReady: false,
    stackManageOpen: false,
  },
  on: {
    APP_READY: {
      actions: assign({ isReady: true }),
    },
    FILTER_SELECTED: {
      actions: assign(({ event }) => ({ currentFilter: event.filter })),
    },
    STACK_SELECTED: {
      actions: assign(({ event }) => ({ currentStack: event.stackId })),
    },
    STACK_SELECTED_ALL: {
      actions: assign({ currentStack: null }),
    },
    SEARCH_UPDATED: {
      actions: assign(({ event }) => ({ searchQuery: event.query })),
    },
    SORT_UPDATED: {
      actions: assign(({ event }) => ({ currentSort: event.sort })),
    },
    STACKS_LOADED: {
      actions: assign(({ event }) => ({ stacks: event.stacks })),
    },
    STACK_MANAGE_TOGGLED: {
      actions: assign(({ context }) => ({ stackManageOpen: !context.stackManageOpen })),
    },
    STACK_DELETED: {
      actions: assign(({ context, event }) => ({
        currentStack: context.currentStack === event.stackId ? null : context.currentStack,
        stacks: context.stacks.filter((stack) => stack.id !== event.stackId),
      })),
    },
  },
});
```

**Step 2: Typecheck**

```bash
bun run typecheck
```

Expected: errors in `app.ts` only (not in the machine files themselves).

---

### Task 4: Update the state machine tests

**Files:**
- Modify: `tests/unit/app-state-machines.test.ts`

XState actors are started, sent events, and queried via `getSnapshot()`. Replace the reducer call pattern.

**Step 1: Rewrite the test file**

```typescript
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
```

**Step 2: Run the tests**

```bash
bun test tests/unit/app-state-machines.test.ts
```

Expected: all tests pass.

**Step 3: Commit**

```bash
git add src/ui/state/add-form-machine.ts src/ui/state/app-machine.ts tests/unit/app-state-machines.test.ts
git commit -m "feat: migrate state machines to XState v5"
```

---

### Task 5: Update `App` class — swap state objects for actors

**Files:**
- Modify: `src/app.ts:1-30` (imports), `src/app.ts:59-62` (class fields), and all call sites throughout the file

This is the largest mechanical change. Replace every `transitionAppState` / `transitionAddFormState` call and every `this.appState.xxx` / `this.addFormState.xxx` read.

**Step 1: Update imports (lines 25–26)**

Remove:
```typescript
import { initialAddFormState, transitionAddFormState } from "./ui/state/add-form-machine";
import { initialAppState, transitionAppState } from "./ui/state/app-machine";
```

Add:
```typescript
import { createActor } from "xstate";
import { addFormMachine } from "./ui/state/add-form-machine";
import { appMachine } from "./ui/state/app-machine";
```

**Step 2: Update class fields (lines 61–62)**

Remove:
```typescript
private appState = initialAppState;
private addFormState = initialAddFormState;
```

Add:
```typescript
private appActor = createActor(appMachine).start();
private addFormActor = createActor(addFormMachine).start();
```

**Step 3: Replace all mutation call sites**

Every occurrence of `this.appState = transitionAppState(this.appState, event)` becomes `this.appActor.send(event)`.
Every occurrence of `this.addFormState = transitionAddFormState(this.addFormState, event)` becomes `this.addFormActor.send(event)`.

Use search-and-replace. In the file there are exactly these patterns to fix:

| Old | New |
|---|---|
| `this.appState = transitionAppState(this.appState, ` | `this.appActor.send(` |
| `this.addFormState = transitionAddFormState(this.addFormState, ` | `this.addFormActor.send(` |

After replacement, each call site will look like:
```typescript
// Before
this.appState = transitionAppState(this.appState, { type: "APP_READY" });
// After
this.appActor.send({ type: "APP_READY" });
```

**Step 4: Replace all state read sites**

Every `this.appState.xxx` becomes `this.appActor.getSnapshot().context.xxx`.
Every `this.addFormState.xxx` becomes `this.addFormActor.getSnapshot().context.xxx`.

To avoid repetition at call sites that read multiple fields, add two private helpers at the bottom of the class:

```typescript
private get appCtx() {
  return this.appActor.getSnapshot().context;
}

private get formCtx() {
  return this.addFormActor.getSnapshot().context;
}
```

Then replace:
- `this.appState.` → `this.appCtx.`
- `this.addFormState.` → `this.formCtx.`

**Step 5: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

**Step 6: Run the full unit test suite**

```bash
bun test tests/unit
```

Expected: all tests pass.

**Step 7: Commit**

```bash
git add src/app.ts
git commit -m "refactor: wire XState actors into App class"
```

---

### Task 6: Add submit loading indicator

**Files:**
- Modify: `src/app.ts` — `createItemFromValues` method and a new `setSubmitButtonState` helper

**Step 1: Add `setSubmitButtonState` helper** (model it after the existing `setScanButtonState` at line 552)

Add this method to the `App` class:

```typescript
private setSubmitButtonState(isLoading: boolean): void {
  const button = document.getElementById("add-form-submit");
  if (!(button instanceof HTMLButtonElement)) return;

  this.addFormActor.send({ type: isLoading ? "SUBMIT_STARTED" : "SUBMIT_FINISHED" });
  button.disabled = isLoading;
  button.textContent = isLoading ? "Adding..." : "Add";
}
```

**Step 2: Wrap the API call in `createItemFromValues` (around line 310)**

The current method:
```typescript
private async createItemFromValues(
  rawValues: AddFormValuesInput,
  form: HTMLFormElement,
  options?: { selectedCandidateId?: string },
): Promise<void> {
  const values = { ...rawValues };
  const enriched = await this.enrichValuesWithMusicBrainz(values);

  try {
    const item = await this.api.createMusicItem({ ... });
    await this.handleCreatedItem(item.id, form);
    this.closeLinkPicker();
  } catch (error) {
    if (error instanceof AmbiguousLinkApiError) {
      this.openLinkPicker(error.payload, rawValues);
      return;
    }
    throw error;
  }
}
```

Update to:
```typescript
private async createItemFromValues(
  rawValues: AddFormValuesInput,
  form: HTMLFormElement,
  options?: { selectedCandidateId?: string },
): Promise<void> {
  const values = { ...rawValues };
  const enriched = await this.enrichValuesWithMusicBrainz(values);

  this.setSubmitButtonState(true);
  try {
    const item = await this.api.createMusicItem({
      ...buildCreateMusicItemInputFromValues(enriched.values),
      listenStatus: "to-listen",
      musicbrainzReleaseId: enriched.musicbrainzReleaseId,
      musicbrainzArtistId: enriched.musicbrainzArtistId,
      selectedCandidateId: options?.selectedCandidateId,
    });

    this.setSubmitButtonState(false);
    await this.handleCreatedItem(item.id, form);
    this.closeLinkPicker();
  } catch (error) {
    this.setSubmitButtonState(false);
    if (error instanceof AmbiguousLinkApiError) {
      this.openLinkPicker(error.payload, rawValues);
      return;
    }
    throw error;
  }
}
```

Note: `setSubmitButtonState(false)` is called on both success and error paths before re-throwing or handling, so the button always recovers.

**Step 3: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

**Step 4: Run all tests**

```bash
bun test tests/unit
```

Expected: all pass.

**Step 5: Commit**

```bash
git add src/app.ts
git commit -m "feat: add submit loading state for release creation"
```

---

### Task 7: Manual smoke test

Start the dev server and verify the loading state works end-to-end:

```bash
bun run dev
```

1. Open the app in a browser
2. Paste a Bandcamp URL into the add form
3. Click "Add" — the button should show "Adding..." and be disabled while the request is in flight
4. After completion, the button should return to "Add" and the release should appear in the list

Also verify the scan button still works (loading state for cover scan was not broken by this change).

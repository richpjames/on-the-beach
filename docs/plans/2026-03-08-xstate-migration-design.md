# XState Migration Design

**Date:** 2026-03-08
**Status:** Approved

## Goal

Migrate both hand-rolled state machines to XState v5, and add a loading indicator for the release creation flow.

## Context

The app has two pure-reducer state machines in `src/ui/state/`:

- `add-form-machine.ts` — form state: `initialized`, `selectedStackIds`, `scanState`
- `app-machine.ts` — app-wide state: `currentFilter`, `currentStack`, `searchQuery`, `currentSort`, `stacks`, `isReady`, `stackManageOpen`

Both follow the same pattern: a state interface, an event union type, and a `transition*` function. The `App` class holds state objects and calls reducers manually.

There is currently no loading indicator when a release is being created (POST to `/api/music-items`), which can take several seconds due to scraping.

## Design

### Approach: XState v5 actors, minimal integration (Option A)

Install `xstate@5`. Replace both reducer functions with `createMachine` + `createActor`. No new reactive patterns — actors are queried on demand via `getSnapshot()`.

### Machine Shape

Each machine uses a flat `context` object (same fields as today) with `assign` actions on `on` handlers.

**`add-form-machine.ts`** gains:
- `submitState: "idle" | "submitting" | "error"` in context
- Events: `SUBMIT_STARTED`, `SUBMIT_FINISHED`, `SUBMIT_ERROR`

**`app-machine.ts`** is a 1:1 port — same context shape, same events.

### Integration

The `App` class replaces state objects with actor references:

```typescript
// Before
private appState = initialAppState;
private addFormState = initialAddFormState;
this.appState = transitionAppState(this.appState, event);

// After
private appActor = createActor(appMachine).start();
private addFormActor = createActor(addFormMachine).start();
this.appActor.send(event);
```

State reads replace `.appState.foo` with `.appActor.getSnapshot().context.foo`.

No subscriptions — the existing on-demand render pattern is preserved.

### Loading Indicator

In `createItemFromValues()` in `app.ts`, wrap the API call:

```
SUBMIT_STARTED → POST /api/music-items → SUBMIT_FINISHED | SUBMIT_ERROR
```

The submit button checks `submitState` during render:
- `submitting` → disabled, text = "Adding..."
- `error` → re-enable, surface error message
- `idle` → normal state

Same pattern as the existing scan button (`setScanButtonState`).

## Files Changed

| File | Change |
|---|---|
| `src/ui/state/add-form-machine.ts` | Rewrite with XState v5 |
| `src/ui/state/app-machine.ts` | Rewrite with XState v5 |
| `src/app.ts` | Update all call sites; add submit loading UI |
| `package.json` | Add `xstate` dependency |

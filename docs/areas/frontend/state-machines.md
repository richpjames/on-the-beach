# State Machines

## Rule

Any logic more complex than a single boolean flag must be captured in a state machine. If a piece of UI or flow behaviour requires more than one bit of information to describe where it "is", it belongs in a machine.

## Why

Ad-hoc conditionals scattered across event handlers and render functions compound quickly. What starts as `if (loading)` becomes `if (loading && !error && retryCount < 3)`. State machines make the full set of states and transitions explicit and auditable in one place, eliminating impossible states by construction.

## What counts as "above a boolean"

- Any loading / error / success lifecycle
- Multi-step flows (e.g. scan → ambiguous match → confirm → submit)
- UI panels or modes with more than two positions
- Retry or polling loops with back-off
- Any state that depends on the *sequence* of prior events, not just current values

A single `isOpen: boolean` does not need a machine. A `scanStatus` that can be idle, scanning, succeeded, or failed does.

## How to implement

Use XState. Machines live under `src/ui/state/`. Each machine should:

1. Name every state explicitly — avoid freeform string unions spread across call sites.
2. Describe every transition as a named event — callers `send({ type: "SCAN_STARTED" })`, they do not mutate state directly.
3. Keep side effects in `invoke` or `entry`/`exit` actions — not in the component or coordinator that drives the machine.
4. Export a typed `snapshot` selector so consumers never read raw machine internals.

## Existing machines

- `app-machine.ts` — browse state: filter, selected stack, search text, sort, panel toggles.
- `add-form-machine.ts` — add-form flow: manual entry, link disambiguation, scan progress, stack selection, submit lifecycle.

New flows follow the same pattern: one file per machine, co-located types, a default export of the machine definition.

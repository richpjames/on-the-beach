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
- Any state that depends on the _sequence_ of prior events, not just current values

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
- `player-machine.ts` — now-playing and the play queue (see below).

New flows follow the same pattern: one file per machine, co-located types, a default export of the machine definition.

## The player machine and its queue

`player-machine.ts` has three playback positions — `idle`, `iframe`, `appleMusic` — and every "start playback" transition targets a concrete state so the outgoing state's `exit` runs first (leaving `appleMusic` stops MusicKit; leaving `iframe` drops the `src`). The queue rides along in the context (`queue: QueueEntry[]`, upcoming-only — the now-playing release is never listed in it):

- `ENQUEUE { entry }` — plays immediately when idle (same semantics as `LOAD_*`), appends when something is playing.
- `ADVANCE` — pops the queue head and starts it through the same concrete-state targets, so the old playback is stopped first. With an empty queue it behaves like `STOP`. Driven by both end-of-playback auto-advance and the manual next button.
- `STOP` — stops now-playing **only**; the queue survives (only `CLEAR_QUEUE` empties it). `LOAD_*` likewise supersedes playback without touching the queue.
- `REMOVE_FROM_QUEUE { index }`, `MOVE_IN_QUEUE { from, to }` (clamped), `CLEAR_QUEUE`, `TOGGLE_QUEUE_WINDOW` — queue-window plumbing.

The facade (`src/lib/player.svelte.ts`) owns the single client-side actor and persists the queue to localStorage under `otb.player.queue` (upcoming entries only; now-playing is re-derived by playback, never persisted). Malformed stored data drops just the bad entries — the queue is a convenience, never worth a crashed player.

### Auto-advance matrix

| Source | End signal | Auto-advances? |
| --- | --- | --- |
| Apple Music (MusicKit) | `playbackStateDidChange` → `ended` (defensive `PlaybackStates` lookup, see `musickit.svelte.ts`) | yes |
| YouTube embed | postMessage `onStateChange` info `0` (`src/lib/youtube-ended.ts`, requires `enablejsapi=1` + `origin` on the src) | yes |
| Bandcamp / SoundCloud / Mixcloud / Apple Music preview iframe | none | no — manual next button only |

Both end signals are generation-guarded: MusicKit's detector bumps a playback generation on every `playResource`/`stop`, and the YouTube watcher's window-level listener is torn down with the iframe it belongs to — so a teardown or a stale player can't masquerade as natural completion and double-advance. Queue rows that can't auto-advance carry a hint glyph in the queue window.

## Using machines in Svelte components

Bridge actors into components with `src/lib/use-machine.svelte.ts` (`useMachine`). It returns a reactive `snapshot` plus `send`, renders the initial snapshot during SSR, and starts the actor on the client. Keep components rendering from `snapshot.context`; do not duplicate machine state into component `$state`.

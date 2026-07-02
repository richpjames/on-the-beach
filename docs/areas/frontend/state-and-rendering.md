# State And Rendering

## State machines

- `src/ui/state/app-machine.ts` stores browse state: current filter, selected stack, search text, sort, stack list, and UI panel toggles. It accepts an input seed (`stacks`, `currentStack`) so server-rendered pages start with the right context.
- `src/ui/state/add-form-machine.ts` stores add-form flow: manual entry, ambiguous link selection, scan progress, selected stacks, and submit lifecycle.
- Version counters such as `listVersion` and `stackBarVersion` trigger targeted refetches from `$effect`s in `MainPage.svelte`.

## Machines + runes

- `src/lib/use-machine.svelte.ts` bridges XState actors into Svelte 5 runes: it exposes a reactive `snapshot` and typed `send`. During SSR the actor is never started — components render the machine's initial snapshot and the machine comes alive on the client.
- Components render directly from `snapshot.context`; side effects (refetching lists, populating form fields from scan results) live in `$effect`s that watch context fields and send acknowledgement events back to the machine.

## Rendering

- Markup lives in Svelte components under `src/lib/components/`; SvelteKit server-renders the initial page from `+page.server.ts` data.
- `src/ui/domain/*` still contains the small view-model helpers for list filters, scan sizing, add-form value shaping, and status display — they are framework-free and unit-tested.
- Drag reordering is the one place the DOM is mutated outside Svelte: sortablejs owns the move, `MusicList.svelte` persists the new order, and the next list refetch re-renders from state.

## Design tradeoff

State stays explicit through XState while Svelte handles rendering reactively. This removes the hand-written DOM synchronisation layer of the previous shell while keeping every flow's states and transitions auditable in one place.

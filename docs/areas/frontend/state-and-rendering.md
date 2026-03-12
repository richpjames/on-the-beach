# State And Rendering

## State machines

- `src/ui/state/app-machine.ts` stores browse state: current filter, selected stack, search text, sort, stack list, and UI panel toggles.
- `src/ui/state/add-form-machine.ts` stores add-form flow: manual entry, ambiguous link selection, scan progress, selected stacks, and submit lifecycle.
- Version counters such as `listVersion` and `stackBarVersion` are used to trigger targeted rerenders from subscriptions.

## Rendering helpers

- `src/ui/view/templates.ts` returns HTML fragments for the music list, stack controls, and editors.
- `src/ui/domain/*` contains small view-model helpers for list filters, scan sizing, add-form value shaping, and status display.
- `src/ui/components/star-rating.ts` isolates rating interactions away from the main app coordinator.

## Design tradeoff

The frontend is intentionally framework-light. State is explicit through XState, while markup updates remain string-template driven. That keeps runtime complexity down, but it makes naming and file boundaries important for maintainability.

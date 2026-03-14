# Test Coverage

## Unit tests

- Unit tests live in `tests/unit`.
- They cover API routes, parsing helpers, scraper behavior, scanning helpers, state machines, RSS output, uploads, and template rendering.
- The default test command is `bun test tests/unit`.

## Browser tests

- Playwright specs live in `playwright/`.
- Coverage includes add flows, stack interactions, drag reorder, mobile behavior, rating, cover replacement, and source-link handling.
- `playwright.config.ts` defines a `chromium` project for smoke E2E tests and two `visual-*` projects for visual regression.

## Visual regression tests

- Visual regression specs live in `tests/visual/`.
- Playwright's built-in `toHaveScreenshot()` is used for screenshot comparison — no external service required.
- Baseline PNGs are committed to the repo in `tests/visual/ui.spec.ts-snapshots/`.
- Baselines **must** be generated on Linux (matching CI) to avoid cross-platform rendering differences causing false positives.

## Useful scripts

- `bun run test:unit`
- `bun run test:e2e`
- `bun run test:visual`
- `bun run test:visual:update`
- `bun run typecheck`

Per the repo instructions, local tests should be run before pushing changes.

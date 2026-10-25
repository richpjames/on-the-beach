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

## Mutation testing

- Stryker checks that the unit tests actually catch regressions: it makes small changes ("mutants") to production code and re-runs the suite. A mutant the suite still passes on is a gap in the tests.
- Run it with `bun run test:mutation`. Stryker instruments the code under test and, for each mutant, runs only the tests that cover it (`coverageAnalysis: perTest`); mutants the suite never touches are reported as "no coverage" without costing a run. A full run takes on the order of fifteen minutes.
- Bun has no native Stryker test runner, so this repo carries a small one in `scripts/stryker-bun/`: a Node-side `TestRunner` plugin (`bun-test-runner.mjs`, loaded via `plugins` in `stryker.config.json`) that spawns `bun test` per run, and a Bun-side harness (`harness-preload.ts` → `harness-shim.ts`) that wraps `bun:test`, assigns stable test ids, attributes Stryker's per-test mutant coverage, filters tests per mutant, and bails after the first failure. The preload is gated on an env var, so plain `bun test` is unaffected.
- The scope is the TypeScript layers (`domain/`, `ports/`, `app/`, `adapters/`, `server/`, `src/`, `eval/`, `scripts/`). `.svelte` components are not mutated — the visual regression suite is their safety net.
- Results land in `reports/mutation/mutation.html` (gitignored). Survived mutants are listed there with the exact change that went unnoticed — each one is either a missing assertion or dead code.
- Runs are incremental: results are cached in `reports/stryker-incremental.json`, so re-running after a change only retests affected mutants. Pass `-- --force` for a clean run.
- To mutation-test a single file while chasing a survivor: `bun run test:mutation -- --mutate domain/title-similarity.ts`. Any extra args are passed through to Stryker.

## Useful scripts

- `bun run test:unit`
- `bun run test:mutation`
- `bun run test:e2e`
- `bun run test:visual`
- `bun run test:visual:update`
- `bun run typecheck`

Per the repo instructions, local tests should be run before pushing changes.

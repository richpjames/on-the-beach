# Test Coverage

## Unit tests

- Unit tests live in `tests/unit`.
- They cover API routes, parsing helpers, scraper behavior, scanning helpers, state machines, RSS output, uploads, and template rendering.
- The default test command is `bun test tests/unit`.

## Browser tests

- Playwright specs live in `playwright/`.
- Coverage includes add flows, stack interactions, drag reorder, mobile behavior, rating, cover replacement, and source-link handling.
- `playwright.config.ts` separates normal Chromium smoke tests from Percy-oriented UI snapshot projects.

## Useful scripts

- `bun run test:unit`
- `bun run test:e2e`
- `bun run test:e2e:ui`
- `bun run typecheck`

Per the repo instructions, local tests should be run before pushing changes.

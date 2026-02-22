# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun run dev              # Start dev server on :3000 (Bun + Vite middleware)
bun run build            # Vite production build → dist/
bun run typecheck        # TypeScript strict check (no emit)
bun run lint             # oxlint
bun run format           # oxfmt --write
bun run format:check     # oxfmt --check

bun run test             # All unit tests
bun test tests/unit/foo.test.ts          # Single unit test file
bun test --watch tests/unit/foo.test.ts  # Watch mode

bun run test:e2e         # Playwright smoke suite (starts server automatically)
bunx playwright test playwright/foo.spec.ts  # Single E2E spec

bun run db:generate      # Generate Drizzle migration after schema change
bun run db:migrate       # Apply pending migrations
bun run db:studio        # Open Drizzle Studio
```

**Quality gates** — run before finishing any change:

```bash
bun run typecheck && bun run lint && bun run format:check && bun run test
```

## Architecture

Full-stack single-process TypeScript app. Bun is the runtime for both server and tooling.

**Server** (`server/`) — Hono.js API over SQLite (bun:sqlite + Drizzle ORM).
**Frontend** (`src/`) — Vanilla TypeScript, no framework. Single `App` class in `src/app.ts` owns all UI state and event handling via delegation.
**Dev server** — One port (3000): `/api/*` → Hono, everything else → Vite middleware.
**Production** — Vite pre-builds to `dist/`, Hono serves static files.

### Key files

| File                           | Role                                                             |
| ------------------------------ | ---------------------------------------------------------------- |
| `server/index.ts`              | Entry point — mounts routes, wires Vite or static serving        |
| `server/routes/music-items.ts` | CRUD for music items + filtering                                 |
| `server/routes/stacks.ts`      | Stack CRUD + item membership                                     |
| `server/db/schema.ts`          | Drizzle schema — edit here, then `db:generate` + `db:migrate`    |
| `server/music-item-creator.ts` | Shared creation logic (used by API + SMTP ingest)                |
| `src/app.ts`                   | All UI: state, rendering, event delegation                       |
| `src/services/api-client.ts`   | Only place that calls `fetch` — all API access goes through here |
| `src/types/index.ts`           | Shared DTO types used by both server and client                  |

### Data model (abbreviated)

- **musicItems** — core entity (title, type, listen_status, purchase_intent, notes, …)
- **artists** — de-duplicated by `normalized_name`
- **musicLinks** — URLs; one primary per item; foreign-keyed to sources
- **sources** — static list of platforms (Bandcamp, Spotify, …)
- **stacks** — user-created collections; unique names
- **musicItemStacks** — many-to-many junction (itemId + stackId PK)

API responses are `snake_case` (DB-aligned). `MusicItemFull` joins in `artist_name`, `primary_url`, `primary_source`.

### Frontend patterns

- **Event delegation**: one listener on container, dispatches via `data-action` / `data-*` attributes.
- **No raw fetch**: always use `ApiClient` methods.
- **Rendering**: methods build HTML strings and set `innerHTML`; no virtual DOM.
- **State**: all in `App` class fields (`currentFilter`, `currentStack`, `stacks`, etc.).

### Testing

- **Unit** (`tests/unit/`) — `bun:test`, pure function tests for parsing/scraping logic.
- **E2E** (`playwright/`) — Playwright, `workers: 1` (serialised, shared SQLite DB). Server runs with `NODE_ENV=test`; `POST /api/__test__/reset` clears DB between specs.

### Database migrations

1. Edit `server/db/schema.ts`
2. `bun run db:generate` → creates file in `drizzle/`
3. `bun run db:migrate` → applies it
4. Commit the generated migration file

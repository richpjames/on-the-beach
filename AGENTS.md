# AGENTS.md

Guidelines for AI agents working on this repository.

## Project Overview

**On The Beach** is a music tracker web app. Users collect links to music, track listening status, and organise items into stacks. The app has a Node/Hono API backend and a Vite/TypeScript frontend, backed by a SQLite database via Drizzle ORM.

## Architecture

```
server/          # Hono API server (Node, TypeScript)
  index.ts       # Entry point – wires Hono + Vite dev middleware
  routes/        # music-items.ts, stacks.ts, test.ts (test-only reset route)
  db/
    schema.ts    # Drizzle schema (sources, artists, musicItems, musicLinks, stacks, musicItemStacks)
    index.ts     # DB connection (better-sqlite3)
    seed.ts      # Seed script
    utils.ts     # Shared DB helpers
  scraper.ts     # URL metadata scraper
  utils.ts       # Shared utilities

src/             # Vite/TypeScript frontend (SPA)
  main.ts        # Entry point
  app.ts         # Root app component
  repository/    # API client layer
  services/      # Business logic / service layer
  types/         # Shared TypeScript types
  styles/        # CSS

tests/unit/      # Vitest unit tests
playwright/      # Playwright E2E specs
```

## Development

**Prerequisites:** Node 24 (see `.nvmrc`), npm.

```bash
npm install
npm run dev          # Dev server on http://localhost:3000 (Hono + Vite HMR on same port)
```

The dev server proxies `/api/*` to Hono and everything else to Vite. No separate ports.

**Database:** SQLite, file path defaults to `./on_the_beach.db`. Managed via Drizzle Kit.

```bash
npm run db:generate  # Generate migration files from schema changes
npm run db:migrate   # Apply pending migrations
npm run db:seed      # Seed the database
npm run db:studio    # Open Drizzle Studio
```

Set `DATABASE_PATH` env var to override the default database file path.

## Testing

Always run tests before committing changes.

```bash
npm run test:unit    # Unit tests (Vitest) — fast, no server needed
npm run test:e2e     # Smoke E2E suite (Playwright) — starts server automatically
npm run test:e2e:full  # Full E2E suite
```

E2E tests run against a real server on port 3000 with `NODE_ENV=test`. Tests are serialised (single worker) because they share one SQLite database. A test-only reset route (`/api/__test__/reset`) is available to wipe state between specs.

When CI is detected (`CI=true`), the Playwright config will not reuse an existing server — it starts a fresh one.

## Linting & Formatting

```bash
npm run lint         # oxlint
npm run format       # oxfmt (auto-fix)
npm run format:check # oxfmt (check only)
npm run typecheck    # tsc --noEmit
```

A pre-commit hook (Husky + lint-staged) runs oxlint and oxfmt on staged `*.{js,jsx,ts,tsx}` files automatically.

## Key Conventions

- **API routes** live under `/api/`. The frontend calls them via the repository layer in `src/repository/`.
- **Schema changes** require a new Drizzle migration (`db:generate` then `db:migrate`). Never edit generated migration files by hand.
- **Listen status values:** `to-listen`, `listening`, `listened`, `revisit`, `done`.
- **Item types:** `album`, `ep`, `single`, `compilation`, `mixtape`, etc. (see schema defaults).
- **Stacks** are user-defined groupings of music items (many-to-many via `musicItemStacks`).
- Keep server and client code strictly separated — nothing in `server/` should import from `src/` and vice versa.

## Production / Deployment

Build and run:

```bash
npm run build        # Vite build → dist/
NODE_ENV=production node dist-server/index.js
```

Docker Compose (`docker-compose.yml`) runs the production build on port 3000. The database file is persisted at the path set by `DATABASE_PATH` (default `/app/data/on_the_beach.db` in Docker).

See `docs/deployment/` for deployment runbooks.

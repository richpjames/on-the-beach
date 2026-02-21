# AGENTS.md

Practical instructions for AI agents building and changing this repository.

## Purpose

On The Beach is a music tracker. Users add music links, track listening/purchase status, and group items into stacks.

This app uses a single-process dev stack:

- Bun runtime
- Hono API
- Vite (frontend dev middleware)
- SQLite (`bun:sqlite`) with Drizzle ORM
- Vanilla TypeScript frontend (no React/Vue/Svelte)

## Source Of Truth

Some historical docs may describe an older architecture. For implementation decisions, trust:

1. `package.json` scripts
2. `server/` and `src/` code
3. test/config files (`playwright.config.ts`, `tests/unit/*`)

## Repository Map

```txt
server/
  index.ts            Hono entrypoint, API registration, Vite middleware in dev
  routes/
    music-items.ts    Music item CRUD + filters
    stacks.ts         Stack CRUD + stack membership routes
    test.ts           Test-only reset route mounted only when NODE_ENV=test
  db/
    index.ts          SQLite + Drizzle init (WAL + foreign_keys ON)
    schema.ts         Table schema and indexes
    seed.ts           Source seed data
  scraper.ts          URL OG metadata scraping/parsing
  utils.ts            URL parsing and normalization helpers

src/
  main.ts             Frontend bootstrap
  app.ts              UI controller/state/event delegation
  services/
    api-client.ts     Browser API client for /api/*
  repository/
    utils.ts          Re-export of shared URL utils for tests/front-end use
  types/
    index.ts          Shared DTO/domain types used by server + client
  styles/
    main.css          App styles

tests/unit/           Bun unit tests
playwright/           Playwright E2E tests
drizzle/              Generated DB migrations
```

## Runtime Architecture

### Development

- `bun run dev` runs `bun --watch server/index.ts` on port `3000`.
- `/api/*` requests are handled by Hono routes.
- non-API requests are handled by Vite middleware.
- There is one port/process for both API and frontend during local dev.

### Setup Commands

```bash
bun install
bun run dev
```

Database helpers:

```bash
bun run db:generate
bun run db:migrate
bun run db:seed
bun run db:studio
```

### Production

- Build frontend with `bun run build` to `dist/`.
- Start server with `NODE_ENV=production bun server/index.ts`.
- Hono serves API and static `dist/` files.

## Data Flow

Typical "add link" flow:

1. UI submits form in `src/app.ts`.
2. `ApiClient.createMusicItem()` sends `POST /api/music-items`.
3. `server/routes/music-items.ts`:
   - validates URL
   - parses source/title hints via `parseUrl()`
   - optionally enriches metadata via `scrapeUrl()`
   - inserts/links artist + item + primary link
4. API returns `MusicItemFull` shape to frontend.
5. UI re-renders list and stack tabs.

Stack flow:

- Stack definitions live in `stacks`.
- Membership is many-to-many in `music_item_stacks`.
- Stack membership routes are under `/api/stacks/items/*`.

## API And Type Contracts

- Shared TypeScript contract is `src/types/index.ts`.
- Request payloads use camelCase (`artistName`, `itemType`, `listenStatus`).
- API response objects for entities use snake_case fields (aligned with DB-facing shapes from route selects).
- When changing contracts:
  - update `src/types/index.ts`
  - update route serializers/selects
  - update `ApiClient`
  - update affected tests

Canonical status/type values currently in use:

- listen status: `to-listen`, `listening`, `listened`, `to-revisit`, `done`
- purchase intent: `no`, `maybe`, `want`, `owned`
- item type: `album`, `ep`, `single`, `track`, `mix`, `compilation`

## Layering Rules

- Keep server logic in `server/` and browser logic in `src/`.
- Frontend should call backend only through `src/services/api-client.ts`.
- Do not issue raw `fetch('/api/...')` from random UI methods when an `ApiClient` method should exist.
- Route handlers own HTTP concerns (status codes, query/path params, JSON parsing).
- DB access should go through Drizzle schema objects, not ad-hoc SQL strings unless necessary.
- Shared helpers should be in a neutral/shared location. The existing `src/repository/utils.ts` re-export from `server/utils.ts` is a legacy bridge; do not expand this pattern unless needed for compatibility.

## Code Standards

### TypeScript

- Keep `strict`-safe code. Avoid `any`.
- Prefer explicit return types for exported functions/methods.
- Narrow unknown input at boundaries (request params/body, query strings).

### Backend (Hono + Drizzle)

- Validate route params early (`Number(...)`, `Number.isNaN` checks).
- Return structured errors: `{ error: string }` with proper HTTP status.
- Keep helper functions near route modules when scope is local (for example `getOrCreateArtist`).
- Update `updatedAt` when mutating mutable entities.
- Preserve DB integrity assumptions (foreign keys enabled; delete order matters in test reset).

### Frontend (Vanilla TS)

- Keep DOM event wiring centralized in `App` setup methods.
- Use event delegation for dynamic list content (current pattern in `setupEventDelegation`).
- Escape user-derived text before HTML insertion (`escapeHtml` pattern).
- Keep state in `App` fields; avoid hidden global mutable state.

### Styling

- Continue using `src/styles/main.css`.
- Reuse existing class naming and component sections.
- Keep mobile-safe layout behavior when adding new UI.

## Database And Migrations

- Default DB path: `./on_the_beach.db`.
- Override with `DATABASE_PATH`.
- After schema edits:
  1. `bun run db:generate`
  2. `bun run db:migrate`
  3. commit migration files under `drizzle/`
- Never hand-edit generated migration SQL unless explicitly required for repair.
- Seed static sources with `bun run db:seed`.

## Testing Standards

- Unit tests: `bun run test:unit`
- E2E smoke: `bun run test:e2e`
- E2E full: `bun run test:e2e:full`

E2E specifics:

- Playwright runs with `workers: 1` (shared SQLite DB).
- `webServer` runs app with `NODE_ENV=test`.
- Reset state between specs via `POST /api/__test__/reset`.
- Test-only routes must stay gated behind `NODE_ENV === "test"`.

## Quality Gates Before Finishing Work

For non-trivial changes, agents should run:

```bash
bun run typecheck
bun run lint
bun run format:check
bun run test:unit
```

If UI/API behavior changed, run at least relevant Playwright specs:

```bash
bun run test:e2e
```

If you cannot run a gate, clearly state what was skipped and why.

## Build/Change Playbook For Agents

When implementing a feature:

1. Add/adjust types in `src/types/index.ts` first.
2. Implement backend route/data behavior in `server/routes/*` and `server/db/*` as needed.
3. Update `ApiClient` methods in `src/services/api-client.ts`.
4. Update UI behavior in `src/app.ts`.
5. Add/adjust unit tests for pure logic changes.
6. Add/adjust Playwright tests for user-visible behavior.
7. Run quality gates.

## Deployment Notes

- Docker Compose uses `docker-compose.yml`.
- In containerized deployment, persist DB file via `DATABASE_PATH` volume mapping.
- See `docs/deployment/` for runbooks.

## Skills

A skill is a set of local instructions in a `SKILL.md` file.

### Available skills

- skill-creator: Guide for creating or updating skills.
  file: `/Users/rich/.codex/skills/.system/skill-creator/SKILL.md`
- skill-installer: Install curated skills or skills from a GitHub repo path.
  file: `/Users/rich/.codex/skills/.system/skill-installer/SKILL.md`

### How to use skills

- Discovery: Use the listed names and paths above as the available skills for this session.
- Trigger rules: If the user names a skill or the task clearly matches its description, use it.
- Missing/blocked: If a skill path cannot be read, state that briefly and continue with best fallback.
- Progressive disclosure:
  1) Open the skill's `SKILL.md`.
  2) Resolve referenced relative paths from the skill directory first.
  3) Load only required referenced files.
  4) Prefer provided scripts/assets/templates over rewriting from scratch.
- Coordination:
  - If multiple skills apply, pick the minimal set and state execution order.
  - Announce which skill is used and why.
- Context hygiene:
  - Keep loaded context small.
  - Avoid deep reference chasing unless blocked.
- Safety fallback:
  - If a skill is unclear or incomplete, state issue and continue with a sound fallback.

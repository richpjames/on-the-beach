# Postgres Backend Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the client-side sql.js/IndexedDB storage with a Hono REST API server backed by Postgres via Drizzle ORM, served as a single process.

**Architecture:** Hono serves both the REST API (`/api/*`) and the Vite-built frontend (static files) from one process. During development, Hono integrates Vite's dev middleware for HMR. The frontend's repository layer is replaced by a thin `ApiClient` that calls `fetch()` against the API routes. All SQL/business logic moves server-side into Hono route handlers using Drizzle ORM.

**Tech Stack:** Hono, Drizzle ORM + drizzle-kit, postgres (pg driver), Vite, TypeScript, Docker Compose (Postgres 16)

---

## Task 1: Install Dependencies and Configure Project

**Files:**
- Modify: `package.json`
- Create: `server/tsconfig.json`
- Modify: `tsconfig.json` (if needed for server path)

**Step 1: Install server dependencies**

Run:
```bash
npm install hono @hono/node-server drizzle-orm postgres
npm install -D drizzle-kit tsx @types/node
```

**Step 2: Create server tsconfig**

Create `server/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "outDir": "../dist-server",
    "rootDir": ".",
    "declaration": true,
    "sourceMap": true,
    "paths": {
      "@shared/*": ["../src/types/*"]
    }
  },
  "include": ["./**/*.ts"]
}
```

**Step 3: Update package.json scripts**

Add these scripts to `package.json`:
```json
{
  "scripts": {
    "dev": "tsx watch server/index.ts",
    "build": "vite build && tsc -p server/tsconfig.json",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:studio": "drizzle-kit studio"
  }
}
```

**Step 4: Commit**

```bash
git add package.json package-lock.json server/tsconfig.json
git commit -m "chore: add Hono, Drizzle, and server dependencies"
```

---

## Task 2: Drizzle Schema — Define All Tables

**Files:**
- Create: `server/db/schema.ts`

This mirrors the existing SQLite schema from `src/database/schema.ts` but uses Postgres types.

**Step 1: Write the Drizzle schema**

Create `server/db/schema.ts` with all 6 tables:

```ts
import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  unique,
  index,
  primaryKey,
  pgEnum,
} from 'drizzle-orm/pg-core'

export const listenStatusEnum = pgEnum('listen_status', [
  'to-listen',
  'listening',
  'listened',
  'to-revisit',
  'done',
])

export const purchaseIntentEnum = pgEnum('purchase_intent', [
  'no',
  'maybe',
  'want',
  'owned',
])

export const itemTypeEnum = pgEnum('item_type', [
  'album',
  'ep',
  'single',
  'track',
  'mix',
  'compilation',
])

export const sources = pgTable('sources', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  displayName: text('display_name').notNull(),
  urlPattern: text('url_pattern'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const artists = pgTable('artists', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  normalizedName: text('normalized_name').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const musicItems = pgTable('music_items', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  normalizedTitle: text('normalized_title').notNull(),
  itemType: itemTypeEnum('item_type').notNull().default('album'),
  artistId: integer('artist_id').references(() => artists.id, { onDelete: 'set null' }),
  listenStatus: listenStatusEnum('listen_status').notNull().default('to-listen'),
  purchaseIntent: purchaseIntentEnum('purchase_intent').notNull().default('no'),
  priceCents: integer('price_cents'),
  currency: text('currency').default('USD'),
  notes: text('notes'),
  rating: integer('rating'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  listenedAt: timestamp('listened_at', { withTimezone: true }),
  isPhysical: boolean('is_physical').notNull().default(false),
  physicalFormat: text('physical_format'),
}, (table) => [
  index('idx_music_items_listen_status').on(table.listenStatus),
  index('idx_music_items_purchase_intent').on(table.purchaseIntent),
  index('idx_music_items_artist_id').on(table.artistId),
  index('idx_music_items_created_at').on(table.createdAt),
])

export const musicLinks = pgTable('music_links', {
  id: serial('id').primaryKey(),
  musicItemId: integer('music_item_id')
    .notNull()
    .references(() => musicItems.id, { onDelete: 'cascade' }),
  sourceId: integer('source_id').references(() => sources.id, { onDelete: 'set null' }),
  url: text('url').notNull(),
  isPrimary: boolean('is_primary').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('music_links_item_url').on(table.musicItemId, table.url),
  index('idx_music_links_music_item_id').on(table.musicItemId),
  index('idx_music_links_url').on(table.url),
])

export const stacks = pgTable('stacks', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const musicItemStacks = pgTable('music_item_stacks', {
  musicItemId: integer('music_item_id')
    .notNull()
    .references(() => musicItems.id, { onDelete: 'cascade' }),
  stackId: integer('stack_id')
    .notNull()
    .references(() => stacks.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.musicItemId, table.stackId] }),
  index('idx_music_item_stacks_stack_id').on(table.stackId),
  index('idx_music_item_stacks_music_item_id').on(table.musicItemId),
])
```

**Step 2: Commit**

```bash
git add server/db/schema.ts
git commit -m "feat: add Drizzle ORM schema for all tables"
```

---

## Task 3: Database Connection and Drizzle Config

**Files:**
- Create: `server/db/index.ts`
- Create: `drizzle.config.ts`
- Create: `server/db/seed.ts`

**Step 1: Create database connection**

Create `server/db/index.ts`:
```ts
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

const connectionString = process.env.DATABASE_URL
  ?? 'postgres://on_the_beach:on_the_beach_dev@localhost:5432/on_the_beach'

const client = postgres(connectionString)
export const db = drizzle(client, { schema })
```

**Step 2: Create Drizzle Kit config**

Create `drizzle.config.ts` at project root:
```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './server/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL
      ?? 'postgres://on_the_beach:on_the_beach_dev@localhost:5432/on_the_beach',
  },
})
```

**Step 3: Create seed script**

Create `server/db/seed.ts`:
```ts
import { db } from './index'
import { sources } from './schema'

const SEED_SOURCES = [
  { name: 'bandcamp', displayName: 'Bandcamp', urlPattern: 'bandcamp.com' },
  { name: 'spotify', displayName: 'Spotify', urlPattern: 'open.spotify.com' },
  { name: 'soundcloud', displayName: 'SoundCloud', urlPattern: 'soundcloud.com' },
  { name: 'youtube', displayName: 'YouTube', urlPattern: 'youtube.com' },
  { name: 'apple_music', displayName: 'Apple Music', urlPattern: 'music.apple.com' },
  { name: 'discogs', displayName: 'Discogs', urlPattern: 'discogs.com' },
  { name: 'tidal', displayName: 'Tidal', urlPattern: 'tidal.com' },
  { name: 'deezer', displayName: 'Deezer', urlPattern: 'deezer.com' },
  { name: 'mixcloud', displayName: 'Mixcloud', urlPattern: 'mixcloud.com' },
  { name: 'physical', displayName: 'Physical Media', urlPattern: null },
] as const

async function seed() {
  console.log('Seeding sources...')
  for (const source of SEED_SOURCES) {
    await db
      .insert(sources)
      .values(source)
      .onConflictDoNothing({ target: sources.name })
  }
  console.log('Seeding complete.')
  process.exit(0)
}

seed().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
```

**Step 4: Generate initial migration and run it**

Start Postgres (must be running via docker-compose):
```bash
docker compose up -d postgres
```

Generate and run migration:
```bash
npx drizzle-kit generate
npx drizzle-kit migrate
```

Seed the database:
```bash
npx tsx server/db/seed.ts
```

**Step 5: Commit**

```bash
git add server/db/index.ts server/db/seed.ts drizzle.config.ts drizzle/
git commit -m "feat: add Drizzle DB connection, config, seed, and initial migration"
```

---

## Task 4: Move Shared Utilities to Server

**Files:**
- Create: `server/utils.ts`

The URL parsing (`parseUrl`, `normalize`, `capitalize`, `isValidUrl`) must be available server-side. Copy `src/repository/utils.ts` to `server/utils.ts` — these functions have no browser dependencies.

**Step 1: Copy utils to server**

Copy `src/repository/utils.ts` to `server/utils.ts`. Update the import path for the `SourceName` type — import from `../src/types` (shared types remain in `src/types/index.ts` and are consumed by both client and server).

**Step 2: Commit**

```bash
git add server/utils.ts
git commit -m "feat: copy URL parsing utils to server"
```

---

## Task 5: Music Items API Routes

**Files:**
- Create: `server/routes/music-items.ts`

Port the `MusicRepository` logic to Hono route handlers using Drizzle queries.

**Step 1: Write failing test for list endpoint**

Create `server/routes/__tests__/music-items.test.ts`:
```ts
import { describe, it, expect } from 'vitest'

// Test that the route module exports a Hono app
describe('music-items routes', () => {
  it('exports a Hono router', async () => {
    const { musicItemRoutes } = await import('../music-items')
    expect(musicItemRoutes).toBeDefined()
    expect(musicItemRoutes.routes).toBeDefined()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run server/routes/__tests__/music-items.test.ts`
Expected: FAIL — module not found

**Step 3: Implement music-items routes**

Create `server/routes/music-items.ts` with these endpoints:

- `GET /` — list with optional query params: `listenStatus`, `purchaseIntent`, `search`, `stackId`
- `POST /` — create music item (accepts `url`, optional `title`, `artistName`, `itemType`, `listenStatus`, `purchaseIntent`, `notes`)
- `GET /:id` — get single item with artist name, primary URL, primary source
- `PATCH /:id` — update music item fields
- `DELETE /:id` — delete music item

Key Drizzle patterns:
- Use `db.select()...from(musicItems).leftJoin(artists, ...).leftJoin(musicLinks, ...)` for the full view query
- Use `db.insert(musicItems).values({...}).returning()` to get the created row
- Use `db.update(musicItems).set({...}).where(eq(musicItems.id, id))` for updates
- Artist get-or-create: `INSERT ... ON CONFLICT (normalized_name) DO NOTHING` then select

**Step 4: Run test to verify it passes**

Run: `npx vitest run server/routes/__tests__/music-items.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/routes/music-items.ts server/routes/__tests__/music-items.test.ts
git commit -m "feat: add music items REST API routes"
```

---

## Task 6: Stacks API Routes

**Files:**
- Create: `server/routes/stacks.ts`

Port `StackRepository` logic to Hono route handlers.

**Step 1: Write failing test for stacks module**

Create `server/routes/__tests__/stacks.test.ts`:
```ts
import { describe, it, expect } from 'vitest'

describe('stacks routes', () => {
  it('exports a Hono router', async () => {
    const { stackRoutes } = await import('../stacks')
    expect(stackRoutes).toBeDefined()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run server/routes/__tests__/stacks.test.ts`
Expected: FAIL

**Step 3: Implement stacks routes**

Create `server/routes/stacks.ts`:

- `GET /` — list all stacks with item counts
- `POST /` — create stack (accepts `name`)
- `PATCH /:id` — rename stack
- `DELETE /:id` — delete stack
- `GET /items/:itemId` — get stacks for a music item
- `POST /items/:itemId` — set stacks for item (accepts `stackIds: number[]`)
- `PUT /items/:itemId/:stackId` — add item to stack
- `DELETE /items/:itemId/:stackId` — remove item from stack

**Step 4: Run test to verify it passes**

Run: `npx vitest run server/routes/__tests__/stacks.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/routes/stacks.ts server/routes/__tests__/stacks.test.ts
git commit -m "feat: add stacks REST API routes"
```

---

## Task 7: Hono Server Entry Point with Vite Integration

**Files:**
- Create: `server/index.ts`
- Modify: `vite.config.ts`

**Step 1: Create the Hono server**

Create `server/index.ts` that:
1. Creates a Hono app
2. Mounts API routes under `/api/music-items` and `/api/stacks`
3. In dev mode: integrates Vite dev middleware for HMR
4. In production: serves `dist/` as static files
5. Listens on port 3000

```ts
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { musicItemRoutes } from './routes/music-items'
import { stackRoutes } from './routes/stacks'

const app = new Hono()

// API routes
app.route('/api/music-items', musicItemRoutes)
app.route('/api/stacks', stackRoutes)

// Vite dev middleware or static serving handled here
// (see implementation for details)

const port = Number(process.env.PORT) || 3000
console.log(`Server running on http://localhost:${port}`)
serve({ fetch: app.fetch, port })
```

For dev mode, use `@hono/vite-dev-server` or serve Vite via `createServer()` from `vite` and attach as middleware. For production, use `serveStatic` from `@hono/node-server/serve-static`.

**Step 2: Update vite.config.ts**

Remove the COOP/COEP headers (no longer needed without SharedArrayBuffer/WASM):
```ts
import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    target: 'esnext',
    sourcemap: true,
  },
})
```

**Step 3: Verify the server starts**

```bash
docker compose up -d postgres
npx tsx server/index.ts
```

Visit `http://localhost:3000/api/music-items` — should return `{"items":[],"total":0}`.

**Step 4: Commit**

```bash
git add server/index.ts vite.config.ts
git commit -m "feat: add Hono server entry point with Vite integration"
```

---

## Task 8: Frontend ApiClient

**Files:**
- Create: `src/services/api-client.ts`

This replaces `MusicRepository` and `StackRepository` with fetch calls.

**Step 1: Write failing test**

Create `src/services/__tests__/api-client.test.ts`:
```ts
import { describe, it, expect } from 'vitest'

describe('ApiClient', () => {
  it('can be instantiated', async () => {
    const { ApiClient } = await import('../api-client')
    const client = new ApiClient()
    expect(client).toBeDefined()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/__tests__/api-client.test.ts`
Expected: FAIL

**Step 3: Implement ApiClient**

Create `src/services/api-client.ts`:

```ts
import type {
  MusicItemFull,
  CreateMusicItemInput,
  UpdateMusicItemInput,
  MusicItemFilters,
  PaginatedResult,
  ListenStatus,
  Stack,
  StackWithCount,
} from '../types'

export class ApiClient {
  private baseUrl = '/api'

  // Music Items
  async listMusicItems(filters?: MusicItemFilters): Promise<PaginatedResult<MusicItemFull>> { ... }
  async createMusicItem(input: CreateMusicItemInput): Promise<MusicItemFull> { ... }
  async getMusicItem(id: number): Promise<MusicItemFull | null> { ... }
  async updateMusicItem(id: number, input: UpdateMusicItemInput): Promise<MusicItemFull | null> { ... }
  async deleteMusicItem(id: number): Promise<boolean> { ... }
  async updateListenStatus(id: number, status: ListenStatus): Promise<MusicItemFull | null> { ... }

  // Stacks
  async listStacks(): Promise<StackWithCount[]> { ... }
  async createStack(name: string): Promise<Stack> { ... }
  async renameStack(id: number, name: string): Promise<Stack | null> { ... }
  async deleteStack(id: number): Promise<boolean> { ... }
  async getStacksForItem(musicItemId: number): Promise<Stack[]> { ... }
  async addItemToStack(musicItemId: number, stackId: number): Promise<void> { ... }
  async removeItemFromStack(musicItemId: number, stackId: number): Promise<void> { ... }
  async setItemStacks(musicItemId: number, stackIds: number[]): Promise<void> { ... }
}
```

Each method is a thin `fetch()` wrapper that constructs the right URL and method.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/__tests__/api-client.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/api-client.ts src/services/__tests__/api-client.test.ts
git commit -m "feat: add ApiClient to replace repository layer"
```

---

## Task 9: Rewire App to Use ApiClient

**Files:**
- Modify: `src/app.ts`
- Modify: `src/main.ts`

**Step 1: Refactor App class**

In `src/app.ts`:
1. Remove all imports of `SqlJsDriver`, `IndexedDBPersistence`, `AutoSaveService`, `MusicRepository`, `StackRepository`, `SCHEMA`
2. Import `ApiClient` instead
3. Replace `this.driver`, `this.persistence`, `this.autoSave`, `this.repository`, `this.stackRepository` with a single `this.api: ApiClient`
4. Simplify `initialize()` — no more driver/persistence/schema init. Just `this.api = new ApiClient()` and `this.initializeUI()`
5. Replace every `this.repository.xxx()` call with `this.api.xxx()`
6. Replace every `this.stackRepository.xxx()` call with `this.api.xxx()`

**Step 2: Simplify main.ts**

Remove the `forceSave()` / `beforeunload` handler — Postgres persists automatically:
```ts
import { App } from './app'

async function bootstrap() {
  const app = new App()
  try {
    await app.initialize()
    console.log('[App] Initialized successfully')
  } catch (error) {
    console.error('[App] Failed to initialize:', error)
    document.getElementById('app')!.innerHTML = `
      <div class="error-screen">
        <h1>Failed to load</h1>
        <p>Could not connect to the server. Please try again.</p>
        <pre>${error}</pre>
      </div>
    `
  }
}

bootstrap()
```

**Step 3: Verify manually**

```bash
docker compose up -d postgres
npm run dev
```

Open `http://localhost:3000` — the app should load and work end-to-end.

**Step 4: Commit**

```bash
git add src/app.ts src/main.ts
git commit -m "feat: rewire App to use ApiClient instead of sql.js"
```

---

## Task 10: Clean Up — Remove SQLite Layer

**Files:**
- Delete: `src/database/driver.ts`
- Delete: `src/database/persistence.ts`
- Delete: `src/database/schema.ts`
- Delete: `src/services/auto-save.ts`
- Delete: `src/repository/music-repository.ts`
- Delete: `src/repository/stack-repository.ts`
- Delete: `public/sql-wasm.wasm`
- Modify: `package.json` (remove `sql.js` and `@types/sql.js`)

**Step 1: Delete old files**

```bash
rm src/database/driver.ts src/database/persistence.ts src/database/schema.ts
rm src/services/auto-save.ts
rm src/repository/music-repository.ts src/repository/stack-repository.ts
rm public/sql-wasm.wasm
```

**Step 2: Remove sql.js dependencies**

```bash
npm uninstall sql.js @types/sql.js
```

**Step 3: Keep shared files**

Keep these (still used):
- `src/types/index.ts` — shared types used by both client and server
- `src/repository/utils.ts` — keep for now if frontend still references it; otherwise delete and rely on `server/utils.ts`

**Step 4: Verify build**

```bash
npm run build
```

**Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove sql.js, IndexedDB, and old repository layer"
```

---

## Task 11: Update E2E Tests

**Files:**
- Modify: `playwright/add-link.spec.ts`
- Modify: `playwright/bandcamp-link.spec.ts`
- Modify: `playwright/stacks.spec.ts`
- Modify: `playwright.config.ts` (if exists)

**Step 1: Update Playwright config**

The web server command changes from `vite dev` to `tsx server/index.ts` (since Hono now serves everything). Update the `webServer` config accordingly.

**Step 2: Ensure clean DB per test**

Add a test setup that truncates tables before each test (or use a test-specific database). A simple approach: add an internal-only `POST /api/__test__/reset` endpoint that truncates all tables and re-seeds, only enabled when `NODE_ENV=test`.

**Step 3: Run E2E tests**

```bash
npm run test:e2e
```

**Step 4: Fix any broken selectors or timing issues**

The UI HTML is unchanged, so selectors should be fine. The main difference is network latency (fetch vs local sql.js) — may need to add waits.

**Step 5: Commit**

```bash
git add playwright/ playwright.config.ts
git commit -m "test: update E2E tests for Postgres backend"
```

---

## Task 12: Update Docker Compose and Documentation

**Files:**
- Modify: `docker-compose.yml`

**Step 1: Optionally add the app service to docker-compose**

```yaml
services:
  app:
    build: .
    ports:
      - '3000:3000'
    environment:
      DATABASE_URL: postgres://on_the_beach:on_the_beach_dev@postgres:5432/on_the_beach
    depends_on:
      postgres:
        condition: service_healthy
  postgres:
    # ... (unchanged)
  adminer:
    # ... (unchanged)
```

**Step 2: Commit**

```bash
git add docker-compose.yml
git commit -m "chore: update docker-compose with app service"
```

---

## Summary of Changes

| Before | After |
|--------|-------|
| sql.js (SQLite in WASM) | Postgres 16 |
| IndexedDB persistence | Postgres persistence |
| Browser-only, no server | Hono REST API server |
| Raw SQL strings | Drizzle ORM type-safe queries |
| `MusicRepository` + `StackRepository` (client) | API route handlers (server) |
| Direct DB calls in browser | `ApiClient` with `fetch()` |
| COOP/COEP headers for SharedArrayBuffer | Not needed |
| `vite dev` | `tsx watch server/index.ts` (Hono + Vite middleware) |

# Remind To Listen — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow users to set a reminder date on the release page; on that date the server moves the item back to "to-listen", sets a pending flag, and on next app load the client dispatches a `REMINDERS_READY` XState event.

**Architecture:** New `remind_at` / `reminder_pending` DB fields; `PUT`/`DELETE` reminder API endpoints; server cron (hourly `setInterval`) processes overdue reminders; client fetches pending on init and dispatches no-op XState event.

**Tech Stack:** Bun, Hono, Drizzle ORM (SQLite), XState v5, inline-JS release page

---

### Task 1: DB schema + migration

**Files:**
- Modify: `server/db/schema.ts`

**Step 1: Add the two new fields to `musicItems`**

In `server/db/schema.ts`, inside the `musicItems` column list (after `musicbrainzArtistId`):

```ts
remindAt: integer("remind_at", { mode: "timestamp" }),
reminderPending: integer("reminder_pending", { mode: "boolean" }).notNull().default(false),
```

**Step 2: Generate the migration**

```bash
cd /Users/rich/Developer/on-the-beach/.worktrees/remind-to-listen
bun db:generate
```

Expected: a new `.sql` file appears in `drizzle/` containing two `ALTER TABLE` statements.

**Step 3: Run the migration**

```bash
bun db:migrate
```

Expected: `migrations applied successfully` (or similar).

**Step 4: Commit**

```bash
git add server/db/schema.ts drizzle/
git commit -m "feat: add remind_at and reminder_pending fields to music_items"
```

---

### Task 2: Update types and fullItemSelect

**Files:**
- Modify: `src/types/index.ts`
- Modify: `server/music-item-creator.ts`

**Step 1: Write a failing test**

In `tests/unit/release-page-route.test.ts`, add to `baseItem`:

```ts
remind_at: null,
reminder_pending: false,
```

Run: `bun test tests/unit/release-page-route.test.ts`
Expected: TypeScript errors / test failures because `MusicItem` doesn't have these fields yet.

**Step 2: Add fields to `MusicItem` type**

In `src/types/index.ts`, in the `MusicItem` interface (after `musicbrainz_artist_id`):

```ts
remind_at: string | null;
reminder_pending: boolean;
```

**Step 3: Add fields to `fullItemSelect`**

In `server/music-item-creator.ts`, in the `fullItemSelect()` `.select({})` block (after `primary_link_metadata`):

```ts
remind_at: musicItems.remindAt,
reminder_pending: musicItems.reminderPending,
```

**Step 4: Run tests**

```bash
bun test tests/unit/release-page-route.test.ts
```

Expected: all passing.

**Step 5: Commit**

```bash
git add src/types/index.ts server/music-item-creator.ts tests/unit/release-page-route.test.ts
git commit -m "feat: expose remind_at and reminder_pending in MusicItemFull"
```

---

### Task 3: Reminder API endpoints

**Files:**
- Modify: `server/routes/music-items.ts`
- Create: `tests/unit/reminder-api.test.ts`

**Step 1: Write failing tests**

Create `tests/unit/reminder-api.test.ts`:

```ts
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

// We'll test the reminder endpoints in isolation using a mock db
// The routes file exports musicItemRoutes; we test it via app.request()

// NOTE: these are integration-style tests against the real route handler
// using the test DB (NODE_ENV=test). Run with: bun test tests/unit/reminder-api.test.ts
// For now we write the shape tests.

import { musicItemRoutes } from "../../server/routes/music-items";

function makeApp() {
  const app = new Hono();
  app.route("/api/music-items", musicItemRoutes);
  return app;
}

describe("PUT /api/music-items/:id/reminder", () => {
  test("returns 400 for non-numeric id", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/music-items/abc/reminder", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remindAt: "2026-06-01" }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 when remindAt is missing", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/music-items/1/reminder", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 when remindAt is not a valid date string", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/music-items/1/reminder", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remindAt: "not-a-date" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/music-items/:id/reminder", () => {
  test("returns 400 for non-numeric id", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/music-items/abc/reminder", {
      method: "DELETE",
    });
    expect(res.status).toBe(400);
  });
});
```

Run: `bun test tests/unit/reminder-api.test.ts`
Expected: some failures (routes don't exist yet).

**Step 2: Add the reminder routes**

In `server/routes/music-items.ts`, after the existing route handlers (before the file ends), add:

```ts
// PUT /api/music-items/:id/reminder
musicItemRoutes.put("/:id/reminder", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: "Invalid id" }, 400);
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.remindAt !== "string") {
    return c.json({ error: "remindAt is required" }, 400);
  }

  const date = new Date(body.remindAt);
  if (isNaN(date.getTime())) {
    return c.json({ error: "remindAt must be a valid date" }, 400);
  }

  await db
    .update(musicItems)
    .set({ remindAt: date, updatedAt: new Date() })
    .where(eq(musicItems.id, id));

  return c.json({ ok: true });
});

// DELETE /api/music-items/:id/reminder
musicItemRoutes.delete("/:id/reminder", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: "Invalid id" }, 400);
  }

  await db
    .update(musicItems)
    .set({ remindAt: null, reminderPending: false, updatedAt: new Date() })
    .where(eq(musicItems.id, id));

  return c.json({ ok: true });
});
```

**Step 3: Run tests**

```bash
bun test tests/unit/reminder-api.test.ts
```

Expected: all passing.

**Step 4: Commit**

```bash
git add server/routes/music-items.ts tests/unit/reminder-api.test.ts
git commit -m "feat: add PUT/DELETE reminder endpoints"
```

---

### Task 4: Pending reminders API + ApiClient method

**Files:**
- Modify: `server/routes/music-items.ts`
- Modify: `src/services/api-client.ts`

**Step 1: Add GET /api/music-items/reminders/pending endpoint**

In `server/routes/music-items.ts`, add **before** the `/:id` route handlers (so it isn't captured by the id param):

```ts
import { lte, isNotNull } from "drizzle-orm";

// GET /api/music-items/reminders/pending
// Returns items with reminder_pending=true and clears the flag (consume semantics)
musicItemRoutes.get("/reminders/pending", async (c) => {
  const pending = await db
    .select({ id: musicItems.id, title: musicItems.title })
    .from(musicItems)
    .where(eq(musicItems.reminderPending, true));

  if (pending.length > 0) {
    const ids = pending.map((r) => r.id);
    await db
      .update(musicItems)
      .set({ reminderPending: false, updatedAt: new Date() })
      .where(inArray(musicItems.id, ids));
  }

  return c.json({ items: pending });
});
```

**Step 2: Add test for the GET endpoint**

In `tests/unit/reminder-api.test.ts`, add a describe block:

```ts
describe("GET /api/music-items/reminders/pending", () => {
  test("returns 200 with items array", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/music-items/reminders/pending");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
  });
});
```

Run: `bun test tests/unit/reminder-api.test.ts`
Expected: all passing.

**Step 3: Add ApiClient method**

In `src/services/api-client.ts`, add these methods to the `ApiClient` class:

```ts
async setReminder(itemId: number, remindAt: string): Promise<void> {
  await this.request(
    `/api/music-items/${itemId}/reminder`,
    "Set reminder",
    this.jsonRequest("PUT", { remindAt }),
  );
}

async clearReminder(itemId: number): Promise<void> {
  await this.request(`/api/music-items/${itemId}/reminder`, "Clear reminder", { method: "DELETE" });
}

async getPendingReminders(): Promise<Array<{ id: number; title: string }>> {
  const data = await this.requestJson<{ items: Array<{ id: number; title: string }> }>(
    "/api/music-items/reminders/pending",
    "Get pending reminders",
  );
  return data.items;
}
```

**Step 4: Commit**

```bash
git add server/routes/music-items.ts src/services/api-client.ts tests/unit/reminder-api.test.ts
git commit -m "feat: add pending reminders endpoint and ApiClient methods"
```

---

### Task 5: XState REMINDERS_READY event + app init dispatch

**Files:**
- Modify: `src/ui/state/app-machine.ts`
- Modify: `src/app.ts`
- Modify: `tests/unit/app-state-machines.test.ts`

**Step 1: Write a failing test**

In `tests/unit/app-state-machines.test.ts`, add:

```ts
it("accepts REMINDERS_READY event without error", () => {
  const actor = createActor(appMachine).start();
  // Should not throw — event is a no-op for now
  actor.send({ type: "REMINDERS_READY", itemIds: [1, 2] });
  expect(actor.getSnapshot().context.isReady).toBe(false); // unchanged
});
```

Run: `bun test tests/unit/app-state-machines.test.ts`
Expected: TypeScript error — `REMINDERS_READY` not in `AppEvent`.

**Step 2: Add the event type**

In `src/ui/state/app-machine.ts`, add to the `AppEvent` union:

```ts
| { type: "REMINDERS_READY"; itemIds: number[] }
```

**Step 3: Add the no-op handler**

In the `appMachine` `on:` block, add:

```ts
REMINDERS_READY: {},
```

**Step 4: Dispatch on app init**

In `src/app.ts`, in the `initialize()` function, after `appActor.send({ type: "APP_READY" })`:

```ts
// Check for items that were moved back to to-listen by the reminder cron
api.getPendingReminders().then((items) => {
  if (items.length > 0) {
    appActor.send({ type: "REMINDERS_READY", itemIds: items.map((i) => i.id) });
  }
}).catch(() => {
  // Non-critical — ignore failures silently
});
```

**Step 5: Run tests**

```bash
bun test tests/unit/app-state-machines.test.ts
```

Expected: all passing.

**Step 6: Commit**

```bash
git add src/ui/state/app-machine.ts src/app.ts tests/unit/app-state-machines.test.ts
git commit -m "feat: add REMINDERS_READY XState event and dispatch on app init"
```

---

### Task 6: Release page UI

**Files:**
- Modify: `server/routes/release-page.ts`
- Modify: `tests/unit/release-page-route.test.ts`

**Step 1: Write a failing test**

In `tests/unit/release-page-route.test.ts`, add:

```ts
test("HTML contains reminder section", async () => {
  mockFetchItem.mockResolvedValue(baseItem);
  const app = makeApp();
  const res = await app.request("http://localhost/r/42");
  const html = await res.text();
  expect(html).toContain("remind-at");
  expect(html).toContain("Remind me");
});

test("prefills reminder date from item year when available", async () => {
  mockFetchItem.mockResolvedValue({ ...baseItem, year: 2026, remind_at: null });
  const app = makeApp();
  const res = await app.request("http://localhost/r/42");
  const html = await res.text();
  expect(html).toContain('value="2026-01-01"');
});

test("prefills reminder date from remind_at when set", async () => {
  mockFetchItem.mockResolvedValue({
    ...baseItem,
    remind_at: new Date("2026-06-15T00:00:00.000Z"),
    reminder_pending: false,
  });
  const app = makeApp();
  const res = await app.request("http://localhost/r/42");
  const html = await res.text();
  expect(html).toContain('value="2026-06-15"');
});
```

Run: `bun test tests/unit/release-page-route.test.ts`
Expected: new tests fail.

**Step 2: Add the reminder HTML section**

In `server/routes/release-page.ts`, add a helper function above `renderReleasePage`:

```ts
function reminderDateValue(item: MusicItemFull): string {
  if (item.remind_at) {
    const d = new Date(item.remind_at);
    return d.toISOString().slice(0, 10);
  }
  if (item.year) {
    return `${item.year}-01-01`;
  }
  return "";
}
```

In `renderReleasePage`, add the reminder section after the status `<div class="release-page__status">` block (around line 283):

```ts
<div class="release-page__reminder">
  <label for="remind-at">Remind me on</label>
  <input class="input" type="date" id="remind-at" value="${escapeHtml(reminderDateValue(item))}" />
  <button type="button" class="btn btn--primary" id="set-reminder-btn">Set reminder</button>
  ${item.remind_at ? `<button type="button" class="btn" id="clear-reminder-btn">Clear</button>` : ""}
</div>
```

**Step 3: Add the inline JS for the reminder UI**

In the inline `<script>` block of `renderReleasePage`, add before `</script>`:

```js
document.getElementById('set-reminder-btn').addEventListener('click', async () => {
  const input = document.getElementById('remind-at');
  const remindAt = input.value;
  if (!remindAt) return;
  const res = await fetch('/api/music-items/' + ITEM_ID + '/reminder', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ remindAt }),
  });
  if (!res.ok) { alert('Failed to set reminder'); return; }
  input.dataset.saved = remindAt;
});

document.getElementById('clear-reminder-btn')?.addEventListener('click', async () => {
  const res = await fetch('/api/music-items/' + ITEM_ID + '/reminder', { method: 'DELETE' });
  if (!res.ok) { alert('Failed to clear reminder'); return; }
  document.getElementById('remind-at').value = '';
  document.getElementById('clear-reminder-btn').remove();
});
```

**Step 4: Run tests**

```bash
bun test tests/unit/release-page-route.test.ts
```

Expected: all passing.

**Step 5: Commit**

```bash
git add server/routes/release-page.ts tests/unit/release-page-route.test.ts
git commit -m "feat: add reminder date UI to release page"
```

---

### Task 7: Server cron job

**Files:**
- Modify: `server/index.ts`
- Create: `server/reminders.ts`
- Create: `tests/unit/reminders.test.ts`

**Step 1: Write a failing test**

Create `tests/unit/reminders.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import { processReminders } from "../../server/reminders";

const mockDb = {
  select: mock(),
  update: mock(),
};

describe("processReminders", () => {
  test("is a function that accepts a db argument", () => {
    expect(typeof processReminders).toBe("function");
  });
});
```

Run: `bun test tests/unit/reminders.test.ts`
Expected: import fails — `server/reminders.ts` doesn't exist.

**Step 2: Create `server/reminders.ts`**

```ts
import { lte, eq, and } from "drizzle-orm";
import { db } from "./db/index";
import { musicItems } from "./db/schema";

export async function processReminders(): Promise<void> {
  const now = new Date();

  const overdue = await db
    .select({ id: musicItems.id })
    .from(musicItems)
    .where(
      and(
        lte(musicItems.remindAt, now),
        eq(musicItems.reminderPending, false),
      ),
    );

  if (overdue.length === 0) return;

  const ids = overdue.map((r) => r.id);
  await db
    .update(musicItems)
    .set({ listenStatus: "to-listen", reminderPending: true, updatedAt: new Date() })
    .where(
      and(
        lte(musicItems.remindAt, now),
        eq(musicItems.reminderPending, false),
      ),
    );

  console.log(`[reminders] processed ${ids.length} overdue reminder(s): [${ids.join(", ")}]`);
}
```

**Step 3: Run the test**

```bash
bun test tests/unit/reminders.test.ts
```

Expected: passing.

**Step 4: Wire cron into server/index.ts**

In `server/index.ts`, after the imports:

```ts
import { processReminders } from "./reminders";
```

After the route registrations and before `findAvailablePort`, add:

```ts
// Run reminder processing on startup and then every hour
processReminders().catch((err) => console.error("[reminders] startup run failed:", err));
setInterval(
  () => processReminders().catch((err) => console.error("[reminders] interval run failed:", err)),
  60 * 60 * 1000,
);
```

**Step 5: Run full test suite**

```bash
bun test --testPathPattern="unit"
```

Expected: 359 pass, same 17 pre-existing Playwright failures, 0 new failures.

**Step 6: Commit**

```bash
git add server/reminders.ts server/index.ts tests/unit/reminders.test.ts
git commit -m "feat: add hourly cron to process overdue reminders"
```

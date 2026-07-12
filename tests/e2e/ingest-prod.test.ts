// End-to-end check that a shared link actually lands in production.
//
// This exercises the exact server round-trip the iOS/macOS Share Extension
// performs: POST the link to /api/ingest/link with the bearer ingest key, then
// confirm the item is really in the database, then delete it again so prod isn't
// polluted. It is the wire-level equivalent of tapping "Add" in the share sheet.
//
// SCOPE (be honest about it): this covers the ingest pipeline + prod
// reachability — the server side. It does NOT drive the native share-sheet UI,
// so it would not catch a bug that lives purely in ShareViewController.swift
// (URL extraction, request construction). Pair with a native UI test if you want
// that layer covered.
//
// It hits REAL production and writes real data, so:
//   - It is gated on OTB_INGEST_API_KEY — with no key the suite skips (this keeps
//     it out of the hermetic `bun test tests/unit` run and off unconfigured CI).
//   - Every item it creates is tagged with a MARKER note and deleted in teardown;
//     a startup purge also removes any orphans a previously-crashed run left, so
//     the test is self-cleaning without ever touching your real items (a duplicate
//     of an existing URL never receives the marker, so it can't be mistaken for
//     ours).
//
// Run:  OTB_INGEST_API_KEY=<key> bun run test:ingest:prod

import { test, expect, beforeAll, afterAll } from "bun:test";

const BASE = process.env.OTB_TEST_BASE_URL ?? "https://onthebeach.ricojam.es";
const KEY = process.env.OTB_INGEST_API_KEY ?? process.env.INGEST_API_KEY ?? "";
// A stable, real link the extension would share. Override if it ever collides
// with something genuinely in your library (see the items_created assertion).
const TEST_URL = process.env.OTB_TEST_URL ?? "https://www.youtube.com/watch?v=8viXaKorY_8";
// Stamped into every item this test creates so teardown/purge can identify its
// own items unambiguously — never a real one.
const MARKER = "OTB_E2E_TEST_DO_NOT_KEEP";

interface IngestResult {
  items_created: number;
  items_skipped: number;
  items: Array<{ id: number; title: string; url: string }>;
  skipped: Array<{ url: string; reason: string }>;
}

interface Item {
  id: number;
  primary_url: string;
  notes: string | null;
  links?: Array<{ url: string }>;
}

function ingestLink(url: string, notes: string): Promise<Response> {
  return fetch(`${BASE}/api/ingest/link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ url, notes }),
  });
}

function getItem(id: number): Promise<Response> {
  return fetch(`${BASE}/api/music-items/${id}`);
}

// DELETE is CSRF-guarded; a matching Origin header satisfies the double-submit
// check without a cookie round-trip (see server/csrf.ts).
function deleteItem(id: number): Promise<Response> {
  return fetch(`${BASE}/api/music-items/${id}`, {
    method: "DELETE",
    headers: { Origin: BASE },
  });
}

/** Delete every item this test has ever created (identified by MARKER note). */
async function purgeMarked(): Promise<void> {
  const res = await fetch(`${BASE}/api/music-items`);
  if (!res.ok) return;
  const { items } = (await res.json()) as { items: Item[] };
  for (const item of items) {
    if (item.notes === MARKER) await deleteItem(item.id);
  }
}

// No key → nothing to test against. Skip loudly rather than fail so the default
// unit run and unconfigured CI stay green.
const run = KEY ? test : test.skip;
if (!KEY) {
  console.warn("[ingest-prod] OTB_INGEST_API_KEY not set — skipping prod ingest e2e");
}

beforeAll(async () => {
  if (KEY) await purgeMarked();
});

afterAll(async () => {
  if (KEY) await purgeMarked();
});

run(
  "a shared link lands in production and can be removed",
  async () => {
    // 1. Share it — the exact call the Share Extension makes.
    const res = await ingestLink(TEST_URL, MARKER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as IngestResult;

    // A duplicate (URL already in your library) yields no created item and no
    // marker, so we can't safely own/clean it — fail with guidance instead.
    expect(
      body.items_created,
      `Expected to create the item, but got skipped=${JSON.stringify(body.skipped)}. ` +
        `The test URL may already be in your library — set OTB_TEST_URL to a different link.`,
    ).toBe(1);
    const id = body.items[0].id;

    // 2. It's really there.
    const got = await getItem(id);
    expect(got.status).toBe(200);
    const item = (await got.json()) as Item;
    const landed =
      item.primary_url === TEST_URL || (item.links ?? []).some((l) => l.url === TEST_URL);
    expect(landed, `item ${id} did not carry the shared URL`).toBe(true);

    // 3. Clean it back out.
    const del = await deleteItem(id);
    expect(del.status).toBe(200);
    expect(((await del.json()) as { success: boolean }).success).toBe(true);

    // 4. Confirm it's gone.
    expect((await getItem(id)).status).toBe(404);
  },
  60_000,
);

import { afterEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../../server/db/index";
import { artists, musicItems } from "../../server/db/schema";
import { musicItemRoutes } from "../../server/routes/music-items";

// A previous secondary-link lookup that came up empty stamps `lookupAttemptedAt`
// so the release page stops re-querying on every view. Because the catalogue
// search keys off only the title and artist, editing either has to clear that
// marker — otherwise correcting a mistyped release name can never produce the
// listen link the corrected name would have found.

const insertedItemIds: number[] = [];

function makeApp() {
  const app = new Hono();
  app.route("/api/music-items", musicItemRoutes);
  return app;
}

const ATTEMPTED_AT = new Date("2026-01-01T00:00:00Z");

async function insertItem(
  overrides: Partial<{ title: string; artistId: number | null }> = {},
): Promise<number> {
  const [inserted] = await db
    .insert(musicItems)
    .values({
      title: overrides.title ?? "Untitled",
      normalizedTitle: (overrides.title ?? "Untitled").toLowerCase(),
      artistId: overrides.artistId ?? null,
      listenStatus: "to-listen",
      lookupAttemptedAt: ATTEMPTED_AT,
    })
    .returning({ id: musicItems.id });

  insertedItemIds.push(inserted.id);
  return inserted.id;
}

async function readLookupAttemptedAt(id: number): Promise<Date | null> {
  const rows = await db
    .select({ lookupAttemptedAt: musicItems.lookupAttemptedAt })
    .from(musicItems)
    .where(eq(musicItems.id, id))
    .limit(1);

  return rows[0]?.lookupAttemptedAt ?? null;
}

function patch(id: number, body: Record<string, unknown>) {
  return makeApp().request(`http://localhost/api/music-items/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  if (insertedItemIds.length === 0) return;
  await db.delete(musicItems).where(inArray(musicItems.id, insertedItemIds));
  insertedItemIds.length = 0;
});

describe("PATCH /api/music-items/:id — lookup marker reset", () => {
  test("clears the marker when the title changes", async () => {
    const id = await insertItem({ title: "Sun Ra - Lanquidity" });

    const res = await patch(id, { title: "Lanquidity" });

    expect(res.status).toBe(200);
    expect(await readLookupAttemptedAt(id)).toBeNull();
  });

  test("keeps the marker when the title is re-saved unchanged", async () => {
    const id = await insertItem({ title: "Lanquidity" });

    const res = await patch(id, { title: "Lanquidity", notes: "reissue" });

    expect(res.status).toBe(200);
    expect(await readLookupAttemptedAt(id)).toEqual(ATTEMPTED_AT);
  });

  test("clears the marker when the artist changes", async () => {
    const id = await insertItem({ title: "Lanquidity" });

    const res = await patch(id, { artistName: "Sun Ra" });

    expect(res.status).toBe(200);
    expect(await readLookupAttemptedAt(id)).toBeNull();

    const [artist] = await db
      .select({ id: artists.id })
      .from(artists)
      .where(eq(artists.name, "Sun Ra"))
      .limit(1);
    expect(artist).toBeDefined();
  });

  test("keeps the marker when the artist is re-saved unchanged", async () => {
    const [artist] = await db
      .insert(artists)
      .values({ name: "Alice Coltrane", normalizedName: "alice coltrane" })
      .onConflictDoNothing()
      .returning({ id: artists.id });
    const artistId =
      artist?.id ??
      (
        await db
          .select({ id: artists.id })
          .from(artists)
          .where(eq(artists.name, "Alice Coltrane"))
          .limit(1)
      )[0]!.id;

    const id = await insertItem({ title: "Journey in Satchidananda", artistId });

    const res = await patch(id, { artistName: "Alice Coltrane" });

    expect(res.status).toBe(200);
    expect(await readLookupAttemptedAt(id)).toEqual(ATTEMPTED_AT);
  });

  test("keeps the marker when only unrelated fields change", async () => {
    const id = await insertItem({ title: "Lanquidity" });

    const res = await patch(id, { notes: "picked up in Bristol", year: 1978 });

    expect(res.status).toBe(200);
    expect(await readLookupAttemptedAt(id)).toEqual(ATTEMPTED_AT);
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { musicItemRoutes } from "../../server/routes/music-items";
import { createMusicItemDirect } from "../../app/music-item-store";
import { itemOrderEntry } from "../../domain/music-list-context";
import { db } from "../../adapters/db/index";
import { musicItemOrder, musicItems } from "../../adapters/db/schema";

// The list route must honour a saved custom order in the default view order
// (date-added, newest first, no search) — the same view the SSR renders and
// the only one the UI allows dragging in. It used to gate on a `sort=default`
// sentinel no client ever sent, so a refetch silently dropped the order.

// Item creation must never reach the live web — but the flag has to be
// restored afterwards: bun runs test files in one process, and a leaked
// OTB_DISABLE_EXTERNAL_LOOKUPS makes other files' enrichment tests misbehave.
const LOOKUPS_BEFORE = process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";

// The rows this file writes, so afterAll can take them back out: bun runs
// every test file in one process against the same database, and a leftover
// order row would reorder a neighbouring file's default-view list.
const createdIds: number[] = [];

afterAll(async () => {
  if (LOOKUPS_BEFORE === undefined) delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
  else process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = LOOKUPS_BEFORE;
  await db.delete(musicItemOrder).where(eq(musicItemOrder.contextKey, "filter:to-listen"));
  if (createdIds.length > 0) {
    await db.delete(musicItems).where(inArray(musicItems.id, createdIds));
  }
});

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/music-items", musicItemRoutes);
  return app;
}

/** The returned ids restricted to the ones this test created, in list order. */
async function listOrder(query: string, ids: number[]): Promise<number[]> {
  const res = await makeApp().request(`http://localhost/api/music-items?${query}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: Array<{ id: number }> };
  const mine = new Set(ids);
  return body.items.map((i) => i.id).filter((id) => mine.has(id));
}

describe("GET /api/music-items custom order", () => {
  test("applies the saved order in the default view order, and only there", async () => {
    // Created First → Second → Third, so date-added desc is Third, Second, First.
    const first = (await createMusicItemDirect({ title: "OrderRoute First" })).item;
    const second = (await createMusicItemDirect({ title: "OrderRoute Second" })).item;
    const third = (await createMusicItemDirect({ title: "OrderRoute Third" })).item;
    const ids = [first.id, second.id, third.id];
    createdIds.push(...ids);

    const save = await makeApp().request("http://localhost/api/music-items/order", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contextKey: "filter:to-listen",
        entries: [itemOrderEntry(first.id), itemOrderEntry(third.id), itemOrderEntry(second.id)],
      }),
    });
    expect(save.status).toBe(200);

    const savedOrder = [first.id, third.id, second.id];

    // No sort params and the explicit default both carry the custom order.
    expect(await listOrder("listenStatus=to-listen", ids)).toEqual(savedOrder);
    expect(
      await listOrder("listenStatus=to-listen&sort=date-added&sortDirection=desc", ids),
    ).toEqual(savedOrder);

    // Any other view order sorts past it: ascending dates, a named sort, or a
    // search all ignore the saved order. (The API param is `sortDirection` —
    // `dir` is only the page-URL spelling.)
    expect(
      await listOrder("listenStatus=to-listen&sort=date-added&sortDirection=asc", ids),
    ).toEqual([first.id, second.id, third.id]);
    expect(
      await listOrder("listenStatus=to-listen&sort=release-name&sortDirection=asc", ids),
    ).toEqual([first.id, second.id, third.id]);
    expect(await listOrder("listenStatus=to-listen&search=OrderRoute", ids)).toEqual([
      third.id,
      second.id,
      first.id,
    ]);
  });
});

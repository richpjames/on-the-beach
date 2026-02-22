import { Hono } from "hono";
import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "../db/index";
import { musicItems, artists, musicItemStacks, stacks } from "../db/schema";
import { isValidUrl, normalize } from "../utils";
import {
  fullItemSelect,
  fetchFullItem,
  getOrCreateArtist,
  createMusicItemFromUrl,
  hydrateItemStacks,
} from "../music-item-creator";
import type {
  CreateMusicItemInput,
  UpdateMusicItemInput,
  ListenStatus,
  PurchaseIntent,
} from "../../src/types";

export const musicItemRoutes = new Hono();

// ---------------------------------------------------------------------------
// GET / — list music items
// ---------------------------------------------------------------------------

musicItemRoutes.get("/", async (c) => {
  const { listenStatus, purchaseIntent, search, stackId } = c.req.query();

  // Start building conditions
  const conditions = [];

  if (listenStatus) {
    const statuses = listenStatus.split(",") as ListenStatus[];
    conditions.push(inArray(musicItems.listenStatus, statuses));
  }

  if (purchaseIntent) {
    const intents = purchaseIntent.split(",") as PurchaseIntent[];
    conditions.push(inArray(musicItems.purchaseIntent, intents));
  }

  if (search) {
    const term = `%${normalize(search)}%`;
    conditions.push(
      sql`(${musicItems.normalizedTitle} LIKE ${term} OR LOWER(${artists.name}) LIKE ${term})`,
    );
  }

  if (stackId) {
    const sid = Number(stackId);
    conditions.push(
      sql`${musicItems.id} IN (SELECT ${musicItemStacks.musicItemId} FROM ${musicItemStacks} WHERE ${musicItemStacks.stackId} = ${sid})`,
    );
  }

  let query = fullItemSelect().$dynamic();

  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  query = query.orderBy(sql`${musicItems.createdAt} DESC`);

  const items = await query;

  // Hydrate stacks for all returned items in a single extra query
  let stackRows: Array<{ musicItemId: number; id: number; name: string }> = [];
  if (items.length > 0) {
    stackRows = await db
      .select({
        musicItemId: musicItemStacks.musicItemId,
        id: stacks.id,
        name: stacks.name,
      })
      .from(musicItemStacks)
      .innerJoin(stacks, eq(stacks.id, musicItemStacks.stackId))
      .where(
        inArray(
          musicItemStacks.musicItemId,
          items.map((i) => i.id),
        ),
      );
  }

  const enriched = hydrateItemStacks(items, stackRows);

  return c.json({ items: enriched, total: enriched.length });
});

// ---------------------------------------------------------------------------
// POST / — create a music item
// ---------------------------------------------------------------------------

musicItemRoutes.post("/", async (c) => {
  const input = (await c.req.json()) as CreateMusicItemInput;

  if (!input.url || !isValidUrl(input.url)) {
    return c.json({ error: "Invalid or missing URL" }, 400);
  }

  try {
    const result = await createMusicItemFromUrl(input.url, input);
    return c.json(result.item, 201);
  } catch {
    return c.json({ error: "Failed to create music item" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /:id — get a single music item
// ---------------------------------------------------------------------------

musicItemRoutes.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (Number.isNaN(id)) {
    return c.json({ error: "Invalid ID" }, 400);
  }

  const item = await fetchFullItem(id);
  if (!item) {
    return c.json({ error: "Not found" }, 404);
  }

  return c.json(item);
});

// ---------------------------------------------------------------------------
// PATCH /:id — update a music item
// ---------------------------------------------------------------------------

musicItemRoutes.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (Number.isNaN(id)) {
    return c.json({ error: "Invalid ID" }, 400);
  }

  const input = (await c.req.json()) as UpdateMusicItemInput;

  // Build the dynamic set object
  const setFields: Record<string, unknown> = {};

  if (input.title !== undefined) {
    setFields.title = input.title;
    setFields.normalizedTitle = normalize(input.title);
  }
  if (input.itemType !== undefined) {
    setFields.itemType = input.itemType;
  }
  if (input.listenStatus !== undefined) {
    setFields.listenStatus = input.listenStatus;
    if (input.listenStatus === "listened" || input.listenStatus === "done") {
      setFields.listenedAt = new Date();
    }
  }
  if (input.purchaseIntent !== undefined) {
    setFields.purchaseIntent = input.purchaseIntent;
  }
  if (input.notes !== undefined) {
    setFields.notes = input.notes;
  }
  if (input.rating !== undefined) {
    setFields.rating = input.rating;
  }
  if (input.priceCents !== undefined) {
    setFields.priceCents = input.priceCents;
  }
  if (input.currency !== undefined) {
    setFields.currency = input.currency;
  }

  // Handle artist name changes
  if (input.artistName !== undefined) {
    if (input.artistName) {
      setFields.artistId = await getOrCreateArtist(input.artistName);
    } else {
      setFields.artistId = null;
    }
  }

  if (Object.keys(setFields).length > 0) {
    setFields.updatedAt = new Date();

    await db.update(musicItems).set(setFields).where(eq(musicItems.id, id));
  }

  const item = await fetchFullItem(id);
  if (!item) {
    return c.json({ error: "Not found" }, 404);
  }

  return c.json(item);
});

// ---------------------------------------------------------------------------
// DELETE /:id — delete a music item
// ---------------------------------------------------------------------------

musicItemRoutes.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (Number.isNaN(id)) {
    return c.json({ error: "Invalid ID" }, 400);
  }

  const result = await db
    .delete(musicItems)
    .where(eq(musicItems.id, id))
    .returning({ id: musicItems.id });

  return c.json({ success: result.length > 0 });
});

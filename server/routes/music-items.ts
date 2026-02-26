import { Hono } from "hono";
import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "../db/index";
import { musicItems, artists, musicItemStacks, stacks, musicItemOrder } from "../db/schema";
import { isValidUrl, normalize } from "../utils";
import {
  fullItemSelect,
  fetchFullItem,
  getOrCreateArtist,
  createMusicItemFromUrl,
  createMusicItemDirect,
  hydrateItemStacks,
} from "../music-item-creator";
import type {
  CreateMusicItemInput,
  UpdateMusicItemInput,
  ListenStatus,
  PurchaseIntent,
} from "../../src/types";

export const musicItemRoutes = new Hono();
const LOCAL_UPLOADS_PATTERN = /^\/uploads\/[A-Za-z0-9._-]+$/;

function buildContextKey(listenStatus: string | undefined, stackId: string | undefined): string {
  const filter = listenStatus || "all";
  const stack = stackId ? Number(stackId) : null;
  if (filter === "all" && stack === null) return "all";
  if (filter === "all") return `stack:${stack}`;
  if (stack === null) return `filter:${filter}`;
  return `filter:${filter}:stack:${stack}`;
}

function isValidArtworkUrl(value: string): boolean {
  return isValidUrl(value) || LOCAL_UPLOADS_PATTERN.test(value);
}

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

  // Apply custom sort order if one exists for this context
  const contextKey = buildContextKey(listenStatus, stackId);
  const orderRow = await db
    .select()
    .from(musicItemOrder)
    .where(eq(musicItemOrder.contextKey, contextKey))
    .get();

  let finalItems: typeof enriched = enriched;
  if (orderRow) {
    const orderedIds = JSON.parse(orderRow.itemIds) as number[];
    const indexMap = new Map(orderedIds.map((id, i) => [id, i]));
    finalItems = [...enriched].sort((a, b) => {
      const ai = indexMap.get(a.id) ?? Infinity;
      const bi = indexMap.get(b.id) ?? Infinity;
      return ai - bi;
    });
  }

  return c.json({ items: finalItems, total: finalItems.length });
});

// ---------------------------------------------------------------------------
// POST / — create a music item
// ---------------------------------------------------------------------------

musicItemRoutes.post("/", async (c) => {
  const input = (await c.req.json()) as CreateMusicItemInput;
  if (input.artworkUrl !== undefined && !isValidArtworkUrl(input.artworkUrl)) {
    return c.json({ error: "Invalid artwork URL" }, 400);
  }

  try {
    let result;
    if (input.url && isValidUrl(input.url)) {
      result = await createMusicItemFromUrl(input.url, input);
    } else if (input.url) {
      return c.json({ error: "Invalid URL" }, 400);
    } else {
      result = await createMusicItemDirect(input);
    }
    return c.json(result.item, 201);
  } catch (err) {
    console.error("[api] POST /api/music-items error:", err);
    return c.json({ error: "Failed to create music item" }, 500);
  }
});

// ---------------------------------------------------------------------------
// PUT /order — save custom sort order for a context
// ---------------------------------------------------------------------------

musicItemRoutes.put("/order", async (c) => {
  const body = (await c.req.json()) as { contextKey?: string; itemIds?: number[] };

  if (!body.contextKey || !Array.isArray(body.itemIds)) {
    return c.json({ error: "contextKey and itemIds are required" }, 400);
  }

  await db
    .insert(musicItemOrder)
    .values({
      contextKey: body.contextKey,
      itemIds: JSON.stringify(body.itemIds),
    })
    .onConflictDoUpdate({
      target: musicItemOrder.contextKey,
      set: { itemIds: JSON.stringify(body.itemIds) },
    });

  return c.json({ success: true });
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
  if (input.label !== undefined) {
    setFields.label = input.label;
  }
  if (input.year !== undefined) {
    setFields.year = input.year;
  }
  if (input.country !== undefined) {
    setFields.country = input.country;
  }
  if (input.genre !== undefined) {
    setFields.genre = input.genre;
  }
  if (input.catalogueNumber !== undefined) {
    setFields.catalogueNumber = input.catalogueNumber;
  }
  if (input.artworkUrl !== undefined) {
    if (input.artworkUrl !== null && !isValidArtworkUrl(input.artworkUrl)) {
      return c.json({ error: "Invalid artwork URL" }, 400);
    }
    setFields.artworkUrl = input.artworkUrl;
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

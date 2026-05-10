import { Hono } from "hono";
import { eq, and, inArray, isNotNull, sql, desc, asc, lte } from "drizzle-orm";
import { db } from "../db/index";
import {
  musicItems,
  artists,
  musicItemStacks,
  stacks,
  musicItemOrder,
  stackParents,
  musicLinks,
  sources,
  itemSuggestions,
} from "../db/schema";
import { isValidUrl, normalize } from "../utils";
import { applyOrder, buildContextKey } from "../../shared/music-list-context";
import {
  AmbiguousLinkSelectionError,
  fullItemSelect,
  fetchFullItem,
  getOrCreateArtist,
  createMusicItemFromUrl,
  createMusicItemDirect,
} from "../music-item-creator";
import { hydrateItemStacks } from "../hydrate-item-stacks";
import { UnsupportedMusicLinkError } from "../scraper";
import { fetchAndStoreSuggestion } from "../suggestions";
import type {
  CreateMusicItemInput,
  UpdateMusicItemInput,
  ListenStatus,
  PurchaseIntent,
  ItemType,
} from "../../src/types";

export const musicItemRoutes = new Hono();
const LOCAL_UPLOADS_PATTERN = /^\/uploads\/[A-Za-z0-9._-]+$/;
type MusicItemUpdateSet = Record<string, unknown>;

const DIRECT_UPDATE_FIELDS: ReadonlyArray<
  | "itemType"
  | "purchaseIntent"
  | "notes"
  | "rating"
  | "priceCents"
  | "currency"
  | "label"
  | "year"
  | "country"
  | "genre"
  | "catalogueNumber"
  | "musicbrainzReleaseId"
  | "musicbrainzArtistId"
> = [
  "itemType",
  "purchaseIntent",
  "notes",
  "rating",
  "priceCents",
  "currency",
  "label",
  "year",
  "country",
  "genre",
  "catalogueNumber",
  "musicbrainzReleaseId",
  "musicbrainzArtistId",
];

export async function collectDescendantStackIds(rootStackId: number): Promise<number[]> {
  const links = await db
    .select({
      parentStackId: stackParents.parentStackId,
      childStackId: stackParents.childStackId,
    })
    .from(stackParents);

  const childrenByParent = new Map<number, number[]>();
  for (const link of links) {
    const children = childrenByParent.get(link.parentStackId) ?? [];
    children.push(link.childStackId);
    childrenByParent.set(link.parentStackId, children);
  }

  const descendants = new Set<number>([rootStackId]);
  const queue = [rootStackId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      continue;
    }

    const children = childrenByParent.get(current) ?? [];
    for (const child of children) {
      if (descendants.has(child)) {
        continue;
      }

      descendants.add(child);
      queue.push(child);
    }
  }

  return [...descendants];
}

function isValidArtworkUrl(value: string): boolean {
  return isValidUrl(value) || LOCAL_UPLOADS_PATTERN.test(value);
}

function applyTitleUpdate(setFields: MusicItemUpdateSet, input: UpdateMusicItemInput): void {
  if (input.title === undefined) {
    return;
  }

  setFields.title = input.title;
  setFields.normalizedTitle = normalize(input.title);
}

function applyListenStatusUpdate(setFields: MusicItemUpdateSet, input: UpdateMusicItemInput): void {
  if (input.listenStatus === undefined) {
    return;
  }

  setFields.listenStatus = input.listenStatus;
  if (input.listenStatus === "listened" || input.listenStatus === "done") {
    setFields.listenedAt = new Date();
  }
}

function applyDirectUpdateFields(setFields: MusicItemUpdateSet, input: UpdateMusicItemInput): void {
  for (const field of DIRECT_UPDATE_FIELDS) {
    const value = input[field];
    if (value !== undefined) {
      setFields[field] = value;
    }
  }
}

function applyArtworkUpdate(setFields: MusicItemUpdateSet, input: UpdateMusicItemInput): boolean {
  if (input.artworkUrl === undefined) {
    return true;
  }

  if (input.artworkUrl !== null && !isValidArtworkUrl(input.artworkUrl)) {
    return false;
  }

  setFields.artworkUrl = input.artworkUrl;
  return true;
}

async function applyArtistUpdate(
  setFields: MusicItemUpdateSet,
  input: UpdateMusicItemInput,
): Promise<void> {
  if (input.artistName === undefined) {
    return;
  }

  if (input.artistName) {
    setFields.artistId = await getOrCreateArtist(input.artistName);
    return;
  }

  setFields.artistId = null;
}

// ---------------------------------------------------------------------------
// GET / — list music items
// ---------------------------------------------------------------------------

musicItemRoutes.get("/", async (c) => {
  const { listenStatus, purchaseIntent, search, sort, sortDirection, stackId, hasReminder } =
    c.req.query();
  const parsedStackId = stackId ? Number(stackId) : null;
  if (parsedStackId !== null && (!Number.isInteger(parsedStackId) || parsedStackId <= 0)) {
    return c.json({ error: "Invalid stack ID" }, 400);
  }

  const validSorts = [
    "date-added",
    "date-listened",
    "artist-name",
    "release-name",
    "star-rating",
  ] as const;
  type ValidSort = (typeof validSorts)[number];
  const requestedSort: ValidSort = validSorts.includes(sort as ValidSort)
    ? (sort as ValidSort)
    : "date-added";
  if (sort && !validSorts.includes(sort as ValidSort)) {
    return c.json({ error: "Invalid sort" }, 400);
  }

  const dir = sortDirection === "asc" ? "asc" : "desc";

  // Start building conditions
  const conditions = [];

  if (hasReminder === "true") {
    conditions.push(isNotNull(musicItems.remindAt));
  } else if (listenStatus) {
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
      sql`(
        ${musicItems.normalizedTitle} LIKE ${term}
        OR ${artists.normalizedName} LIKE ${term}
        OR EXISTS (
          SELECT 1
          FROM ${musicItemStacks}
          INNER JOIN ${stacks} ON ${stacks.id} = ${musicItemStacks.stackId}
          WHERE ${musicItemStacks.musicItemId} = ${musicItems.id}
            AND LOWER(${stacks.name}) LIKE ${term}
        )
      )`,
    );
  }

  if (parsedStackId !== null) {
    const stackIds = await collectDescendantStackIds(parsedStackId);
    const memberships = await db
      .select({ musicItemId: musicItemStacks.musicItemId })
      .from(musicItemStacks)
      .where(inArray(musicItemStacks.stackId, stackIds));
    const itemIds = [...new Set(memberships.map((membership) => membership.musicItemId))];

    if (itemIds.length === 0) {
      return c.json({ items: [], total: 0 });
    }

    conditions.push(inArray(musicItems.id, itemIds));
  }

  let query = fullItemSelect().$dynamic();

  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  if (requestedSort === "artist-name") {
    query = query.orderBy(
      sql`CASE WHEN ${artists.normalizedName} IS NULL OR ${artists.normalizedName} = '' THEN 1 ELSE 0 END`,
      dir === "asc" ? asc(artists.normalizedName) : desc(artists.normalizedName),
      dir === "asc" ? asc(musicItems.normalizedTitle) : desc(musicItems.normalizedTitle),
      desc(musicItems.id),
    );
  } else if (requestedSort === "release-name") {
    query = query.orderBy(
      dir === "asc" ? asc(musicItems.normalizedTitle) : desc(musicItems.normalizedTitle),
      sql`CASE WHEN ${artists.normalizedName} IS NULL OR ${artists.normalizedName} = '' THEN 1 ELSE 0 END`,
      dir === "asc" ? asc(artists.normalizedName) : desc(artists.normalizedName),
      desc(musicItems.id),
    );
  } else if (requestedSort === "star-rating") {
    query = query.orderBy(
      sql`CASE WHEN ${musicItems.rating} IS NULL THEN 1 ELSE 0 END`,
      dir === "asc" ? asc(musicItems.rating) : desc(musicItems.rating),
      sql`CASE WHEN ${artists.normalizedName} IS NULL OR ${artists.normalizedName} = '' THEN 1 ELSE 0 END`,
      asc(artists.normalizedName),
      asc(musicItems.normalizedTitle),
      desc(musicItems.id),
    );
  } else if (requestedSort === "date-listened") {
    query = query.orderBy(
      sql`CASE WHEN ${musicItems.listenedAt} IS NULL THEN 1 ELSE 0 END`,
      dir === "asc" ? asc(musicItems.listenedAt) : desc(musicItems.listenedAt),
      dir === "asc" ? asc(musicItems.id) : desc(musicItems.id),
    );
  } else {
    // date-added (default)
    query = query.orderBy(
      dir === "asc" ? asc(musicItems.createdAt) : desc(musicItems.createdAt),
      dir === "asc" ? asc(musicItems.id) : desc(musicItems.id),
    );
  }

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
  const contextKey = buildContextKey(listenStatus, parsedStackId);
  const orderRow = await db
    .select()
    .from(musicItemOrder)
    .where(eq(musicItemOrder.contextKey, contextKey))
    .get();

  let finalItems: typeof enriched = enriched;
  if (orderRow && requestedSort === "default" && !search) {
    const parsed = JSON.parse(orderRow.itemIds);
    if (Array.isArray(parsed) && parsed.length > 0) {
      if (typeof parsed[0] === "number") {
        // Legacy format: plain item IDs
        finalItems = applyOrder(enriched, parsed as number[]);
      } else {
        // New format: extract item IDs in order, ignore stack entries for item sorting
        const itemIds = (parsed as string[])
          .filter((e: string) => e.startsWith("i:"))
          .map((e: string) => Number(e.slice(2)));
        finalItems = applyOrder(enriched, itemIds);
      }
    }
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
    if (result.item.listen_status === "to-listen" && result.item.artist_name) {
      void fetchAndStoreSuggestion({
        id: result.item.id,
        artist_name: result.item.artist_name,
        year: result.item.year,
        musicbrainz_artist_id: result.item.musicbrainz_artist_id,
      });
    }
    return c.json(result.item, 201);
  } catch (err) {
    if (err instanceof AmbiguousLinkSelectionError) {
      return c.json(err.payload, 409);
    }

    if (err instanceof UnsupportedMusicLinkError) {
      return c.json({ error: err.message }, 400);
    }

    console.error("[api] POST /api/music-items error:", err);
    return c.json({ error: "Failed to create music item" }, 500);
  }
});

// ---------------------------------------------------------------------------
// PUT /order — save custom sort order for a context
// ---------------------------------------------------------------------------

musicItemRoutes.put("/order", async (c) => {
  const body = (await c.req.json()) as {
    contextKey?: string;
    itemIds?: number[];
    entries?: string[];
  };

  if (!body.contextKey) {
    return c.json({ error: "contextKey is required" }, 400);
  }

  let serialized: string;
  if (body.entries) {
    serialized = JSON.stringify(body.entries);
  } else if (body.itemIds) {
    serialized = JSON.stringify(body.itemIds);
  } else {
    return c.json({ error: "entries or itemIds are required" }, 400);
  }

  await db
    .insert(musicItemOrder)
    .values({ contextKey: body.contextKey, itemIds: serialized })
    .onConflictDoUpdate({
      target: musicItemOrder.contextKey,
      set: { itemIds: serialized },
    });

  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// GET /reminders/pending — consume pending reminders (clears the flag)
// ---------------------------------------------------------------------------

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

  const setFields: MusicItemUpdateSet = {};
  applyTitleUpdate(setFields, input);
  applyListenStatusUpdate(setFields, input);
  applyDirectUpdateFields(setFields, input);

  if (!applyArtworkUpdate(setFields, input)) {
    return c.json({ error: "Invalid artwork URL" }, 400);
  }

  await applyArtistUpdate(setFields, input);

  if (Object.keys(setFields).length > 0) {
    setFields.updatedAt = new Date();

    await db.update(musicItems).set(setFields).where(eq(musicItems.id, id));
  }

  const item = await fetchFullItem(id);
  if (!item) {
    return c.json({ error: "Not found" }, 404);
  }

  let suggestion = null;
  if (input.listenStatus === "listened") {
    try {
      suggestion =
        (await db
          .select()
          .from(itemSuggestions)
          .where(and(eq(itemSuggestions.sourceItemId, id), eq(itemSuggestions.status, "pending")))
          .get()) ?? null;
    } catch {
      // Non-critical — suggestion lookup must not block the status update
    }
  }

  return c.json({ item, suggestion });
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

// ---------------------------------------------------------------------------
// POST /:id/suggestion/accept — accept a pending suggestion
// ---------------------------------------------------------------------------

musicItemRoutes.post("/:id/suggestion/accept", async (c) => {
  const id = Number(c.req.param("id"));
  if (Number.isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

  const suggestion = await db
    .select()
    .from(itemSuggestions)
    .where(and(eq(itemSuggestions.sourceItemId, id), eq(itemSuggestions.status, "pending")))
    .get();

  if (!suggestion) return c.json({ error: "No pending suggestion" }, 404);

  const result = await createMusicItemDirect({
    title: suggestion.title,
    artistName: suggestion.artistName,
    itemType: suggestion.itemType as ItemType,
    listenStatus: "to-listen",
    year: suggestion.year ?? undefined,
    musicbrainzReleaseId: suggestion.musicbrainzReleaseId ?? undefined,
  });

  await db
    .update(itemSuggestions)
    .set({ status: "accepted" })
    .where(eq(itemSuggestions.id, suggestion.id));

  return c.json(result.item, 201);
});

// ---------------------------------------------------------------------------
// POST /:id/suggestion/dismiss — dismiss a pending suggestion
// ---------------------------------------------------------------------------

musicItemRoutes.post("/:id/suggestion/dismiss", async (c) => {
  const id = Number(c.req.param("id"));
  if (Number.isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

  await db
    .update(itemSuggestions)
    .set({ status: "dismissed" })
    .where(and(eq(itemSuggestions.sourceItemId, id), eq(itemSuggestions.status, "pending")));

  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// GET /:id/links — list all links for a music item
// ---------------------------------------------------------------------------

musicItemRoutes.get("/:id/links", async (c) => {
  const id = Number(c.req.param("id"));
  if (Number.isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

  const rows = await db
    .select({
      id: musicLinks.id,
      url: musicLinks.url,
      source_name: sources.name,
      display_name: sources.displayName,
      is_primary: musicLinks.isPrimary,
    })
    .from(musicLinks)
    .leftJoin(sources, eq(musicLinks.sourceId, sources.id))
    .where(eq(musicLinks.musicItemId, id));

  return c.json(rows);
});

// ---------------------------------------------------------------------------
// POST /:id/links — add a link to a music item
// ---------------------------------------------------------------------------

musicItemRoutes.post("/:id/links", async (c) => {
  const id = Number(c.req.param("id"));
  if (Number.isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

  const body = (await c.req.json()) as { sourceName?: unknown; url?: unknown };

  if (typeof body.url !== "string" || !isValidUrl(body.url)) {
    return c.json({ error: "Valid url is required" }, 400);
  }
  if (typeof body.sourceName !== "string" || !body.sourceName.trim()) {
    return c.json({ error: "sourceName is required" }, 400);
  }

  const url = body.url.trim();
  const rawName = body.sourceName.trim();
  const name = rawName.toLowerCase().replace(/\s+/g, "_");
  const displayName = rawName.charAt(0).toUpperCase() + rawName.slice(1);

  // Upsert source — insert if new, reuse if existing
  await db.insert(sources).values({ name, displayName }).onConflictDoNothing();

  const [source] = await db
    .select({ id: sources.id, name: sources.name, displayName: sources.displayName })
    .from(sources)
    .where(eq(sources.name, name))
    .limit(1);

  // Check whether this item already has any link (to determine isPrimary)
  const existing = await db
    .select({ id: musicLinks.id })
    .from(musicLinks)
    .where(eq(musicLinks.musicItemId, id))
    .limit(1);

  const isPrimary = existing.length === 0;

  const [link] = await db
    .insert(musicLinks)
    .values({ musicItemId: id, sourceId: source.id, url, isPrimary })
    .onConflictDoNothing()
    .returning({ id: musicLinks.id, url: musicLinks.url, isPrimary: musicLinks.isPrimary });

  if (!link) {
    return c.json({ error: "Link already exists for this release" }, 409);
  }

  return c.json(
    {
      id: link.id,
      url: link.url,
      source_name: source.name,
      display_name: source.displayName,
      is_primary: link.isPrimary,
    },
    201,
  );
});

// ---------------------------------------------------------------------------
// DELETE /:id/links/:linkId — remove a link from a music item
// ---------------------------------------------------------------------------

musicItemRoutes.delete("/:id/links/:linkId", async (c) => {
  const id = Number(c.req.param("id"));
  const linkId = Number(c.req.param("linkId"));
  if (Number.isNaN(id) || Number.isNaN(linkId)) return c.json({ error: "Invalid ID" }, 400);

  const result = await db
    .delete(musicLinks)
    .where(and(eq(musicLinks.id, linkId), eq(musicLinks.musicItemId, id)))
    .returning({ id: musicLinks.id });

  return c.json({ success: result.length > 0 });
});

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

import { Hono } from "hono";
import { eq, and, count, asc } from "drizzle-orm";
import { db } from "../db";
import { stacks, musicItemStacks, stackParents } from "../db/schema";

export const stackRoutes = new Hono();

async function stackExists(stackId: number): Promise<boolean> {
  const row = await db.select({ id: stacks.id }).from(stacks).where(eq(stacks.id, stackId)).get();
  return row !== undefined;
}

async function getParentsByChildMap(): Promise<Map<number, number[]>> {
  const rows = await db
    .select({
      parent_stack_id: stackParents.parentStackId,
      child_stack_id: stackParents.childStackId,
    })
    .from(stackParents);
  const map = new Map<number, number[]>();
  for (const row of rows) {
    const existing = map.get(row.child_stack_id) ?? [];
    existing.push(row.parent_stack_id);
    map.set(row.child_stack_id, existing);
  }
  return map;
}

async function wouldCreateCycle(childStackId: number, parentStackId: number): Promise<boolean> {
  const parentsByChild = await getParentsByChildMap();
  const visited = new Set<number>();
  const queue = [parentStackId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === childStackId) {
      return true;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    const parents = parentsByChild.get(current) ?? [];
    queue.push(...parents);
  }

  return false;
}

async function parentStackIdsForStack(stackId: number): Promise<number[]> {
  const rows = await db
    .select({ parentStackId: stackParents.parentStackId })
    .from(stackParents)
    .where(eq(stackParents.childStackId, stackId));
  return rows.map((r) => r.parentStackId);
}

function parseId(value: string): number | null {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }

  return id;
}

// GET / — list all stacks with item counts
stackRoutes.get("/", async (c) => {
  const rows = await db
    .select({
      id: stacks.id,
      name: stacks.name,
      created_at: stacks.createdAt,
      item_count: count(musicItemStacks.musicItemId),
    })
    .from(stacks)
    .leftJoin(musicItemStacks, eq(stacks.id, musicItemStacks.stackId))
    .groupBy(stacks.id)
    .orderBy(asc(stacks.name));

  const parentsByChild = await getParentsByChildMap();
  return c.json(
    rows.map((row) => ({
      ...row,
      parent_stack_ids: parentsByChild.get(row.id) ?? [],
    })),
  );
});

// POST / — create a new stack
stackRoutes.post("/", async (c) => {
  const body = await c.req.json<{ name: string; parentStackId?: number | null }>();
  const trimmed = body.name?.trim();
  const parentStackId = body.parentStackId ?? null;

  if (!trimmed) {
    return c.json({ error: "Stack name cannot be empty" }, 400);
  }

  if (parentStackId !== null) {
    if (!Number.isInteger(parentStackId) || parentStackId <= 0) {
      return c.json({ error: "Invalid parent stack ID" }, 400);
    }

    if (!(await stackExists(parentStackId))) {
      return c.json({ error: "Parent stack not found" }, 404);
    }
  }

  const [created] = await db.insert(stacks).values({ name: trimmed }).returning();
  if (parentStackId !== null) {
    await db.insert(stackParents).values({ parentStackId, childStackId: created.id });
  }

  return c.json(
    {
      ...created,
      parent_stack_ids: parentStackId !== null ? [parentStackId] : [],
    },
    201,
  );
});

// PATCH /:id — rename a stack
stackRoutes.patch("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) {
    return c.json({ error: "Invalid stack ID" }, 400);
  }

  const body = await c.req.json<{ name: string }>();
  const trimmed = body.name?.trim();

  if (!trimmed) {
    return c.json({ error: "Stack name cannot be empty" }, 400);
  }

  const [updated] = await db
    .update(stacks)
    .set({ name: trimmed })
    .where(eq(stacks.id, id))
    .returning();

  if (!updated) {
    return c.json({ error: "Stack not found" }, 404);
  }

  return c.json({
    ...updated,
    parent_stack_ids: await parentStackIdsForStack(updated.id),
  });
});

// DELETE /:id — delete a stack
stackRoutes.delete("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) {
    return c.json({ error: "Invalid stack ID" }, 400);
  }

  const deleted = await db.delete(stacks).where(eq(stacks.id, id)).returning();

  return c.json({ success: deleted.length > 0 });
});

// PATCH /:id/parent — assign/remove parent stack for a stack
stackRoutes.patch("/:id/parent", async (c) => {
  const childStackId = parseId(c.req.param("id"));
  if (childStackId === null) {
    return c.json({ error: "Invalid stack ID" }, 400);
  }

  const body = await c.req.json<{ parentStackId?: number | null }>();
  if (body.parentStackId === undefined) {
    return c.json({ error: "parentStackId is required" }, 400);
  }

  const parentStackId = body.parentStackId;
  if (!(await stackExists(childStackId))) {
    return c.json({ error: "Stack not found" }, 404);
  }

  if (parentStackId !== null) {
    if (!Number.isInteger(parentStackId) || parentStackId <= 0) {
      return c.json({ error: "Invalid parent stack ID" }, 400);
    }

    if (parentStackId === childStackId) {
      return c.json({ error: "A stack cannot be its own parent" }, 400);
    }

    if (!(await stackExists(parentStackId))) {
      return c.json({ error: "Parent stack not found" }, 404);
    }

    if (await wouldCreateCycle(childStackId, parentStackId)) {
      return c.json({ error: "Cannot create a circular stack hierarchy" }, 400);
    }
  }

  if (parentStackId !== null) {
    await db.insert(stackParents).values({ parentStackId, childStackId }).onConflictDoNothing();
  }

  return c.json({ success: true });
});

// DELETE /:id/parent/:parentId — remove a specific parent relationship
stackRoutes.delete("/:id/parent/:parentId", async (c) => {
  const childStackId = parseId(c.req.param("id"));
  const parentStackId = parseId(c.req.param("parentId"));
  if (childStackId === null || parentStackId === null) {
    return c.json({ error: "Invalid stack ID" }, 400);
  }

  await db
    .delete(stackParents)
    .where(
      and(
        eq(stackParents.childStackId, childStackId),
        eq(stackParents.parentStackId, parentStackId),
      ),
    );

  return c.json({ success: true });
});

// GET /items/:itemId — get stacks for a music item
stackRoutes.get("/items/:itemId", async (c) => {
  const itemId = parseId(c.req.param("itemId"));
  if (itemId === null) {
    return c.json({ error: "Invalid music item ID" }, 400);
  }

  const rows = await db
    .select({
      id: stacks.id,
      name: stacks.name,
      created_at: stacks.createdAt,
    })
    .from(stacks)
    .innerJoin(musicItemStacks, eq(stacks.id, musicItemStacks.stackId))
    .where(eq(musicItemStacks.musicItemId, itemId))
    .orderBy(asc(stacks.name));

  const parentsByChild = await getParentsByChildMap();
  return c.json(
    rows.map((row) => ({
      ...row,
      parent_stack_ids: parentsByChild.get(row.id) ?? [],
    })),
  );
});

// POST /items/:itemId — set stacks for a music item (replace all)
stackRoutes.post("/items/:itemId", async (c) => {
  const itemId = parseId(c.req.param("itemId"));
  if (itemId === null) {
    return c.json({ error: "Invalid music item ID" }, 400);
  }

  const body = await c.req.json<{ stackIds: number[] }>();

  await db.delete(musicItemStacks).where(eq(musicItemStacks.musicItemId, itemId));

  if (body.stackIds?.length) {
    await db
      .insert(musicItemStacks)
      .values(body.stackIds.map((stackId) => ({ musicItemId: itemId, stackId })));
  }

  return c.json({ success: true });
});

// PUT /items/:itemId/:stackId — add item to stack
stackRoutes.put("/items/:itemId/:stackId", async (c) => {
  const itemId = parseId(c.req.param("itemId"));
  const stackId = parseId(c.req.param("stackId"));
  if (itemId === null || stackId === null) {
    return c.json({ error: "Invalid ID" }, 400);
  }

  await db.insert(musicItemStacks).values({ musicItemId: itemId, stackId }).onConflictDoNothing();

  return c.json({ success: true });
});

// DELETE /items/:itemId/:stackId — remove item from stack
stackRoutes.delete("/items/:itemId/:stackId", async (c) => {
  const itemId = parseId(c.req.param("itemId"));
  const stackId = parseId(c.req.param("stackId"));
  if (itemId === null || stackId === null) {
    return c.json({ error: "Invalid ID" }, 400);
  }

  await db
    .delete(musicItemStacks)
    .where(and(eq(musicItemStacks.musicItemId, itemId), eq(musicItemStacks.stackId, stackId)));

  return c.json({ success: true });
});

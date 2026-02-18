import { Hono } from 'hono'
import { eq, and, count, asc } from 'drizzle-orm'
import { db } from '../db'
import { stacks, musicItemStacks } from '../db/schema'

export const stackRoutes = new Hono()

// GET / — list all stacks with item counts
stackRoutes.get('/', async (c) => {
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
    .orderBy(asc(stacks.name))

  return c.json(rows)
})

// POST / — create a new stack
stackRoutes.post('/', async (c) => {
  const body = await c.req.json<{ name: string }>()
  const trimmed = body.name?.trim()

  if (!trimmed) {
    return c.json({ error: 'Stack name cannot be empty' }, 400)
  }

  const [created] = await db
    .insert(stacks)
    .values({ name: trimmed })
    .returning()

  return c.json(created, 201)
})

// PATCH /:id — rename a stack
stackRoutes.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json<{ name: string }>()
  const trimmed = body.name?.trim()

  if (!trimmed) {
    return c.json({ error: 'Stack name cannot be empty' }, 400)
  }

  const [updated] = await db
    .update(stacks)
    .set({ name: trimmed })
    .where(eq(stacks.id, id))
    .returning()

  if (!updated) {
    return c.json({ error: 'Stack not found' }, 404)
  }

  return c.json(updated)
})

// DELETE /:id — delete a stack
stackRoutes.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))

  const deleted = await db
    .delete(stacks)
    .where(eq(stacks.id, id))
    .returning()

  return c.json({ success: deleted.length > 0 })
})

// GET /items/:itemId — get stacks for a music item
stackRoutes.get('/items/:itemId', async (c) => {
  const itemId = Number(c.req.param('itemId'))

  const rows = await db
    .select({
      id: stacks.id,
      name: stacks.name,
      created_at: stacks.createdAt,
    })
    .from(stacks)
    .innerJoin(musicItemStacks, eq(stacks.id, musicItemStacks.stackId))
    .where(eq(musicItemStacks.musicItemId, itemId))
    .orderBy(asc(stacks.name))

  return c.json(rows)
})

// POST /items/:itemId — set stacks for a music item (replace all)
stackRoutes.post('/items/:itemId', async (c) => {
  const itemId = Number(c.req.param('itemId'))
  const body = await c.req.json<{ stackIds: number[] }>()

  await db
    .delete(musicItemStacks)
    .where(eq(musicItemStacks.musicItemId, itemId))

  if (body.stackIds?.length) {
    await db
      .insert(musicItemStacks)
      .values(body.stackIds.map((stackId) => ({ musicItemId: itemId, stackId })))
  }

  return c.json({ success: true })
})

// PUT /items/:itemId/:stackId — add item to stack
stackRoutes.put('/items/:itemId/:stackId', async (c) => {
  const itemId = Number(c.req.param('itemId'))
  const stackId = Number(c.req.param('stackId'))

  await db
    .insert(musicItemStacks)
    .values({ musicItemId: itemId, stackId })
    .onConflictDoNothing()

  return c.json({ success: true })
})

// DELETE /items/:itemId/:stackId — remove item from stack
stackRoutes.delete('/items/:itemId/:stackId', async (c) => {
  const itemId = Number(c.req.param('itemId'))
  const stackId = Number(c.req.param('stackId'))

  await db
    .delete(musicItemStacks)
    .where(
      and(
        eq(musicItemStacks.musicItemId, itemId),
        eq(musicItemStacks.stackId, stackId),
      )
    )

  return c.json({ success: true })
})

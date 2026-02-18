import { Hono } from 'hono'
import { eq, and, inArray, sql } from 'drizzle-orm'
import { db } from '../db/index'
import {
  musicItems,
  artists,
  musicLinks,
  sources,
  musicItemStacks,
} from '../db/schema'
import { parseUrl, isValidUrl, normalize, capitalize } from '../utils'
import type {
  CreateMusicItemInput,
  UpdateMusicItemInput,
  MusicItemFull,
  ListenStatus,
  PurchaseIntent,
} from '../../src/types'

export const musicItemRoutes = new Hono()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the "full" music-item query that joins artists, primary music_link,
 * and sources to produce the MusicItemFull shape the frontend expects.
 */
function fullItemSelect() {
  return db
    .select({
      id: musicItems.id,
      title: musicItems.title,
      normalized_title: musicItems.normalizedTitle,
      item_type: musicItems.itemType,
      artist_id: musicItems.artistId,
      listen_status: musicItems.listenStatus,
      purchase_intent: musicItems.purchaseIntent,
      price_cents: musicItems.priceCents,
      currency: musicItems.currency,
      notes: musicItems.notes,
      rating: musicItems.rating,
      created_at: musicItems.createdAt,
      updated_at: musicItems.updatedAt,
      listened_at: musicItems.listenedAt,
      is_physical: musicItems.isPhysical,
      physical_format: musicItems.physicalFormat,
      artist_name: artists.name,
      primary_url: musicLinks.url,
      primary_source: sources.name,
    })
    .from(musicItems)
    .leftJoin(artists, eq(musicItems.artistId, artists.id))
    .leftJoin(
      musicLinks,
      and(
        eq(musicLinks.musicItemId, musicItems.id),
        eq(musicLinks.isPrimary, true),
      ),
    )
    .leftJoin(sources, eq(musicLinks.sourceId, sources.id))
}

/** Look up an existing artist by normalized name, or create a new one. */
async function getOrCreateArtist(name: string): Promise<number> {
  const normalizedName = normalize(name)

  const existing = await db
    .select({ id: artists.id })
    .from(artists)
    .where(eq(artists.normalizedName, normalizedName))
    .limit(1)

  if (existing[0]) {
    return existing[0].id
  }

  const [created] = await db
    .insert(artists)
    .values({ name: capitalize(name), normalizedName })
    .returning({ id: artists.id })

  return created.id
}

/** Resolve the DB id for a source name (e.g. "bandcamp"). */
async function getSourceId(sourceName: string): Promise<number | null> {
  const rows = await db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.name, sourceName))
    .limit(1)

  return rows[0]?.id ?? null
}

/** Fetch a single full item by its id (reused by create / update / get). */
async function fetchFullItem(id: number): Promise<MusicItemFull | null> {
  const rows = await fullItemSelect().where(eq(musicItems.id, id))
  if (!rows[0]) return null
  // Drizzle returns Date objects for timestamps; the MusicItemFull interface
  // uses string. Hono's c.json() will serialize Dates via JSON.stringify which
  // calls .toISOString(), so the cast is safe at the serialization boundary.
  return rows[0] as unknown as MusicItemFull
}

// ---------------------------------------------------------------------------
// GET / — list music items
// ---------------------------------------------------------------------------

musicItemRoutes.get('/', async (c) => {
  const {
    listenStatus,
    purchaseIntent,
    search,
    stackId,
  } = c.req.query()

  // Start building conditions
  const conditions = []

  if (listenStatus) {
    const statuses = listenStatus.split(',') as ListenStatus[]
    conditions.push(inArray(musicItems.listenStatus, statuses))
  }

  if (purchaseIntent) {
    const intents = purchaseIntent.split(',') as PurchaseIntent[]
    conditions.push(inArray(musicItems.purchaseIntent, intents))
  }

  if (search) {
    const term = `%${normalize(search)}%`
    conditions.push(
      sql`(${musicItems.normalizedTitle} ILIKE ${term} OR ${artists.name} ILIKE ${term})`,
    )
  }

  if (stackId) {
    const sid = Number(stackId)
    conditions.push(
      sql`${musicItems.id} IN (SELECT ${musicItemStacks.musicItemId} FROM ${musicItemStacks} WHERE ${musicItemStacks.stackId} = ${sid})`,
    )
  }

  let query = fullItemSelect().$dynamic()

  if (conditions.length > 0) {
    query = query.where(and(...conditions))
  }

  query = query.orderBy(sql`${musicItems.createdAt} DESC`)

  const items = await query

  return c.json({ items, total: items.length })
})

// ---------------------------------------------------------------------------
// POST / — create a music item
// ---------------------------------------------------------------------------

musicItemRoutes.post('/', async (c) => {
  const input = (await c.req.json()) as CreateMusicItemInput

  if (!input.url || !isValidUrl(input.url)) {
    return c.json({ error: 'Invalid or missing URL' }, 400)
  }

  const parsed = parseUrl(input.url)
  const title = input.title || parsed.potentialTitle || 'Untitled'
  const artistName = input.artistName || parsed.potentialArtist

  // Get or create artist
  let artistId: number | null = null
  if (artistName) {
    artistId = await getOrCreateArtist(artistName)
  }

  // Resolve source
  const sourceId = await getSourceId(parsed.source)

  // Insert music item
  const [inserted] = await db
    .insert(musicItems)
    .values({
      title: capitalize(title),
      normalizedTitle: normalize(title),
      itemType: input.itemType ?? 'album',
      artistId,
      listenStatus: input.listenStatus ?? 'to-listen',
      purchaseIntent: input.purchaseIntent ?? 'no',
      notes: input.notes ?? null,
    })
    .returning({ id: musicItems.id })

  // Insert primary link
  await db.insert(musicLinks).values({
    musicItemId: inserted.id,
    sourceId,
    url: parsed.normalizedUrl,
    isPrimary: true,
  })

  const item = await fetchFullItem(inserted.id)
  if (!item) {
    return c.json({ error: 'Failed to create music item' }, 500)
  }

  return c.json(item, 201)
})

// ---------------------------------------------------------------------------
// GET /:id — get a single music item
// ---------------------------------------------------------------------------

musicItemRoutes.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (Number.isNaN(id)) {
    return c.json({ error: 'Invalid ID' }, 400)
  }

  const item = await fetchFullItem(id)
  if (!item) {
    return c.json({ error: 'Not found' }, 404)
  }

  return c.json(item)
})

// ---------------------------------------------------------------------------
// PATCH /:id — update a music item
// ---------------------------------------------------------------------------

musicItemRoutes.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (Number.isNaN(id)) {
    return c.json({ error: 'Invalid ID' }, 400)
  }

  const input = (await c.req.json()) as UpdateMusicItemInput

  // Build the dynamic set object
  const setFields: Record<string, unknown> = {}

  if (input.title !== undefined) {
    setFields.title = input.title
    setFields.normalizedTitle = normalize(input.title)
  }
  if (input.itemType !== undefined) {
    setFields.itemType = input.itemType
  }
  if (input.listenStatus !== undefined) {
    setFields.listenStatus = input.listenStatus
    if (input.listenStatus === 'listened' || input.listenStatus === 'done') {
      setFields.listenedAt = new Date()
    }
  }
  if (input.purchaseIntent !== undefined) {
    setFields.purchaseIntent = input.purchaseIntent
  }
  if (input.notes !== undefined) {
    setFields.notes = input.notes
  }
  if (input.rating !== undefined) {
    setFields.rating = input.rating
  }
  if (input.priceCents !== undefined) {
    setFields.priceCents = input.priceCents
  }
  if (input.currency !== undefined) {
    setFields.currency = input.currency
  }

  // Handle artist name changes
  if (input.artistName !== undefined) {
    if (input.artistName) {
      setFields.artistId = await getOrCreateArtist(input.artistName)
    } else {
      setFields.artistId = null
    }
  }

  if (Object.keys(setFields).length > 0) {
    setFields.updatedAt = new Date()

    await db
      .update(musicItems)
      .set(setFields)
      .where(eq(musicItems.id, id))
  }

  const item = await fetchFullItem(id)
  if (!item) {
    return c.json({ error: 'Not found' }, 404)
  }

  return c.json(item)
})

// ---------------------------------------------------------------------------
// DELETE /:id — delete a music item
// ---------------------------------------------------------------------------

musicItemRoutes.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (Number.isNaN(id)) {
    return c.json({ error: 'Invalid ID' }, 400)
  }

  const result = await db
    .delete(musicItems)
    .where(eq(musicItems.id, id))
    .returning({ id: musicItems.id })

  return c.json({ success: result.length > 0 })
})

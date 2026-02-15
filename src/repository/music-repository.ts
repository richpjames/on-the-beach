import type { IDatabaseDriver } from '../database/driver'
import type {
  MusicItemFull,
  CreateMusicItemInput,
  UpdateMusicItemInput,
  MusicItemFilters,
  PaginatedResult,
  Source,
  ListenStatus,
} from '../types'
import { parseUrl, normalize, capitalize, isValidUrl } from './utils'

export interface IMusicRepository {
  initialize(): Promise<void>
  createMusicItem(input: CreateMusicItemInput): Promise<MusicItemFull>
  getMusicItem(id: number): Promise<MusicItemFull | null>
  updateMusicItem(id: number, input: UpdateMusicItemInput): Promise<MusicItemFull | null>
  deleteMusicItem(id: number): Promise<boolean>
  listMusicItems(filters?: MusicItemFilters): Promise<PaginatedResult<MusicItemFull>>
  updateListenStatus(id: number, status: ListenStatus): Promise<MusicItemFull | null>
}

export class MusicRepository implements IMusicRepository {
  constructor(private driver: IDatabaseDriver) {}

  async initialize(): Promise<void> {
    // Repository is ready once driver is initialized
  }

  async createMusicItem(input: CreateMusicItemInput): Promise<MusicItemFull> {
    if (!isValidUrl(input.url)) {
      throw new Error('Invalid URL')
    }

    const parsed = parseUrl(input.url)
    const title = input.title || parsed.potentialTitle || 'Untitled'
    const artistName = input.artistName || parsed.potentialArtist

    // Get or create artist if provided
    let artistId: number | null = null
    if (artistName) {
      artistId = await this.getOrCreateArtist(artistName)
    }

    // Get source ID
    const sourceId = await this.getSourceId(parsed.source)

    // Create music item
    const { lastInsertRowId } = await this.driver.run(
      `INSERT INTO music_items (title, normalized_title, item_type, artist_id, listen_status, purchase_intent)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        capitalize(title),
        normalize(title),
        input.itemType || 'album',
        artistId,
        input.listenStatus || 'to-listen',
        input.purchaseIntent || 'no',
      ]
    )

    // Create primary link
    await this.driver.run(
      `INSERT INTO music_links (music_item_id, source_id, url, is_primary)
       VALUES (?, ?, ?, 1)`,
      [lastInsertRowId, sourceId, parsed.normalizedUrl]
    )

    const item = await this.getMusicItem(lastInsertRowId)
    if (!item) throw new Error('Failed to create music item')
    return item
  }

  async getMusicItem(id: number): Promise<MusicItemFull | null> {
    const items = await this.driver.query<MusicItemFull>(
      `SELECT * FROM v_music_items_full WHERE id = ?`,
      [id]
    )
    return items[0] || null
  }

  async updateMusicItem(id: number, input: UpdateMusicItemInput): Promise<MusicItemFull | null> {
    const updates: string[] = []
    const params: unknown[] = []

    if (input.title !== undefined) {
      updates.push('title = ?', 'normalized_title = ?')
      params.push(input.title, normalize(input.title))
    }
    if (input.itemType !== undefined) {
      updates.push('item_type = ?')
      params.push(input.itemType)
    }
    if (input.listenStatus !== undefined) {
      updates.push('listen_status = ?')
      params.push(input.listenStatus)
      if (input.listenStatus === 'listened' || input.listenStatus === 'done') {
        updates.push("listened_at = datetime('now')")
      }
    }
    if (input.purchaseIntent !== undefined) {
      updates.push('purchase_intent = ?')
      params.push(input.purchaseIntent)
    }
    if (input.notes !== undefined) {
      updates.push('notes = ?')
      params.push(input.notes)
    }
    if (input.rating !== undefined) {
      updates.push('rating = ?')
      params.push(input.rating)
    }
    if (input.priceCents !== undefined) {
      updates.push('price_cents = ?')
      params.push(input.priceCents)
    }
    if (input.currency !== undefined) {
      updates.push('currency = ?')
      params.push(input.currency)
    }

    if (updates.length === 0) {
      return this.getMusicItem(id)
    }

    updates.push("updated_at = datetime('now')")
    params.push(id)

    await this.driver.run(
      `UPDATE music_items SET ${updates.join(', ')} WHERE id = ?`,
      params
    )

    return this.getMusicItem(id)
  }

  async updateListenStatus(id: number, status: ListenStatus): Promise<MusicItemFull | null> {
    return this.updateMusicItem(id, { listenStatus: status })
  }

  async deleteMusicItem(id: number): Promise<boolean> {
    const { changes } = await this.driver.run(
      `DELETE FROM music_items WHERE id = ?`,
      [id]
    )
    return changes > 0
  }

  async listMusicItems(filters?: MusicItemFilters): Promise<PaginatedResult<MusicItemFull>> {
    let sql = 'SELECT * FROM v_music_items_full'
    const conditions: string[] = []
    const params: unknown[] = []

    if (filters?.listenStatus) {
      const statuses = Array.isArray(filters.listenStatus)
        ? filters.listenStatus
        : [filters.listenStatus]
      conditions.push(`listen_status IN (${statuses.map(() => '?').join(', ')})`)
      params.push(...statuses)
    }

    if (filters?.purchaseIntent) {
      const intents = Array.isArray(filters.purchaseIntent)
        ? filters.purchaseIntent
        : [filters.purchaseIntent]
      conditions.push(`purchase_intent IN (${intents.map(() => '?').join(', ')})`)
      params.push(...intents)
    }

    if (filters?.search) {
      conditions.push('(normalized_title LIKE ? OR artist_name LIKE ?)')
      const searchTerm = `%${normalize(filters.search)}%`
      params.push(searchTerm, searchTerm)
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ')
    }

    sql += ' ORDER BY created_at DESC'

    const items = await this.driver.query<MusicItemFull>(sql, params)

    return {
      items,
      total: items.length,
    }
  }

  private async getOrCreateArtist(name: string): Promise<number> {
    const normalizedName = normalize(name)

    // Try to find existing artist
    const existing = await this.driver.query<{ id: number }>(
      `SELECT id FROM artists WHERE normalized_name = ?`,
      [normalizedName]
    )

    if (existing[0]) {
      return existing[0].id
    }

    // Create new artist
    const { lastInsertRowId } = await this.driver.run(
      `INSERT INTO artists (name, normalized_name) VALUES (?, ?)`,
      [capitalize(name), normalizedName]
    )

    return lastInsertRowId
  }

  private async getSourceId(sourceName: string): Promise<number | null> {
    const sources = await this.driver.query<Source>(
      `SELECT id FROM sources WHERE name = ?`,
      [sourceName]
    )
    return sources[0]?.id ?? null
  }
}

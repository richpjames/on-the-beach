import type { IDatabaseDriver } from '../database/driver'
import type {
  QueueSyncOperationInput,
  SyncPullResponse,
  SyncPushOperation,
  SyncPushRequest,
  SyncPushResponse,
  SyncRunResult,
} from '../types/sync'
import { AuthService } from './auth'

const LOCAL_SYNC_SCHEMA = `
CREATE TABLE IF NOT EXISTS sync_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id TEXT NOT NULL UNIQUE,
  entity TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  client_updated_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_inbox (
  version INTEGER PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sync_outbox_created_at ON sync_outbox(created_at ASC);
CREATE INDEX IF NOT EXISTS idx_sync_inbox_entity ON sync_inbox(entity, entity_id);
`

interface OutboxRow {
  op_id: string
  entity: string
  action: string
  payload_json: string
  client_updated_at: string
}

interface SyncStateRow {
  value: string
}

export interface SyncServiceConfig {
  baseUrl: string
  deviceId: string
  pushPath?: string
  pullPath?: string
  pushBatchSize?: number
  pullLimit?: number
  maxPullPages?: number
}

const DEFAULT_PUSH_PATH = '/v1/sync/push'
const DEFAULT_PULL_PATH = '/v1/sync/pull'
const DEFAULT_PUSH_BATCH_SIZE = 100
const DEFAULT_PULL_LIMIT = 200
const DEFAULT_MAX_PULL_PAGES = 5

function joinUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  const normalizedPath = path.startsWith('/') ? path : `/${path}`

  if (!normalizedBase) return normalizedPath
  return `${normalizedBase}${normalizedPath}`
}

export class SyncService {
  private initialized = false
  private readonly pushPath: string
  private readonly pullPath: string
  private readonly pushBatchSize: number
  private readonly pullLimit: number
  private readonly maxPullPages: number

  constructor(
    private readonly driver: IDatabaseDriver,
    private readonly authService: AuthService,
    private readonly config: SyncServiceConfig
  ) {
    this.pushPath = config.pushPath ?? DEFAULT_PUSH_PATH
    this.pullPath = config.pullPath ?? DEFAULT_PULL_PATH
    this.pushBatchSize = config.pushBatchSize ?? DEFAULT_PUSH_BATCH_SIZE
    this.pullLimit = config.pullLimit ?? DEFAULT_PULL_LIMIT
    this.maxPullPages = config.maxPullPages ?? DEFAULT_MAX_PULL_PAGES
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await this.driver.exec(LOCAL_SYNC_SCHEMA)
    this.initialized = true
  }

  async queueOperation(input: QueueSyncOperationInput): Promise<string> {
    await this.initialize()

    if (!input.payload.id || input.payload.id.trim() === '') {
      throw new Error('Sync payload requires a non-empty id')
    }

    const opId = input.opId ?? this.createOpId()
    const clientUpdatedAt = input.clientUpdatedAt ?? new Date().toISOString()

    await this.driver.run(
      `INSERT INTO sync_outbox (op_id, entity, action, payload_json, client_updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [opId, input.entity, input.action, JSON.stringify(input.payload), clientUpdatedAt]
    )

    return opId
  }

  async runOnce(): Promise<SyncRunResult> {
    await this.initialize()

    let token = await this.authService.getValidAccessToken()
    if (!token) {
      const refreshed = await this.authService.refreshSession()
      token = refreshed?.accessToken ?? null
    }

    if (!token) {
      const cursor = await this.getCursor()
      return {
        status: 'unauthenticated',
        pushed: 0,
        pulled: 0,
        conflicts: 0,
        cursor,
      }
    }

    const pushResult = await this.pushPendingOps()
    const pullResult = await this.pullChanges()
    const cursor = await this.getCursor()

    return {
      status: 'ok',
      pushed: pushResult.pushed,
      pulled: pullResult.pulled,
      conflicts: pushResult.conflicts,
      cursor,
    }
  }

  private async pushPendingOps(): Promise<{ pushed: number; conflicts: number }> {
    const rows = await this.driver.query<OutboxRow>(
      `SELECT op_id, entity, action, payload_json, client_updated_at
       FROM sync_outbox
       WHERE last_error IS NULL
       ORDER BY id ASC
       LIMIT ?`,
      [this.pushBatchSize]
    )

    if (rows.length === 0) {
      return { pushed: 0, conflicts: 0 }
    }

    const ops: SyncPushOperation[] = rows.map((row) => ({
      opId: row.op_id,
      entity: row.entity as SyncPushOperation['entity'],
      action: row.action as SyncPushOperation['action'],
      payload: JSON.parse(row.payload_json) as SyncPushOperation['payload'],
      clientUpdatedAt: row.client_updated_at,
    }))

    const body: SyncPushRequest = {
      deviceId: this.config.deviceId,
      ops,
    }

    const response = await this.authService.authorizedFetch(joinUrl(this.config.baseUrl, this.pushPath), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      credentials: 'include',
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Sync push failed (${response.status}): ${errorText}`)
    }

    const data = (await response.json()) as SyncPushResponse

    if (data.appliedOpIds.length > 0) {
      await this.deleteAppliedOps(data.appliedOpIds)
    }

    if (data.conflicts.length > 0) {
      await this.markConflicts(data.conflicts)
    }

    return {
      pushed: data.appliedOpIds.length,
      conflicts: data.conflicts.length,
    }
  }

  private async pullChanges(): Promise<{ pulled: number }> {
    let cursor = await this.getCursor()
    let pulled = 0

    for (let page = 0; page < this.maxPullPages; page += 1) {
      const query = new URLSearchParams({
        since: String(cursor),
        limit: String(this.pullLimit),
      }).toString()
      const pullUrl = `${joinUrl(this.config.baseUrl, this.pullPath)}?${query}`

      const response = await this.authService.authorizedFetch(pullUrl, {
        method: 'GET',
        credentials: 'include',
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Sync pull failed (${response.status}): ${errorText}`)
      }

      const data = (await response.json()) as SyncPullResponse

      if (data.changes.length === 0) {
        await this.setCursor(data.nextVersion)
        break
      }

      await this.stageIncomingChanges(data)
      pulled += data.changes.length
      cursor = data.nextVersion

      if (!data.hasMore) {
        break
      }
    }

    return { pulled }
  }

  private async stageIncomingChanges(data: SyncPullResponse): Promise<void> {
    await this.driver.exec('BEGIN TRANSACTION')

    try {
      for (const change of data.changes) {
        await this.applyIncomingChange(change)
        await this.driver.run(
          `INSERT OR REPLACE INTO sync_inbox (version, entity, entity_id, action, payload_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            change.version,
            change.entity,
            change.entityId,
            change.action,
            JSON.stringify(change.payload),
            change.updatedAt,
          ]
        )
      }

      await this.setCursor(data.nextVersion)
      await this.driver.exec('COMMIT')
    } catch (error) {
      await this.driver.exec('ROLLBACK')
      throw error
    }
  }

  private async applyIncomingChange(change: SyncPullResponse['changes'][number]): Promise<void> {
    if (change.action === 'delete') {
      await this.applyDelete(change.entity, change.entityId)
      return
    }

    switch (change.entity) {
      case 'artist':
        await this.applyArtistUpsert(change)
        return
      case 'music_item':
        await this.applyMusicItemUpsert(change)
        return
      case 'music_link':
        await this.applyMusicLinkUpsert(change)
        return
      default:
        throw new Error(`Unsupported sync entity: ${String(change.entity)}`)
    }
  }

  private async applyDelete(entity: string, entityId: string): Promise<void> {
    const id = this.parseInteger(entityId, `${entity}.entityId`)

    if (entity === 'artist') {
      await this.driver.run(`DELETE FROM artists WHERE id = ?`, [id])
      return
    }

    if (entity === 'music_item') {
      await this.driver.run(`DELETE FROM music_items WHERE id = ?`, [id])
      return
    }

    if (entity === 'music_link') {
      await this.driver.run(`DELETE FROM music_links WHERE id = ?`, [id])
      return
    }

    throw new Error(`Unsupported delete entity: ${entity}`)
  }

  private async applyArtistUpsert(change: SyncPullResponse['changes'][number]): Promise<void> {
    const payload = change.payload
    const id = this.parseInteger(payload.id, 'artist.id')
    const name = this.parseString(payload.name, 'artist.name')
    const normalizedName = this.parseString(payload.normalized_name, 'artist.normalized_name')
    const createdAt = this.optionalString(payload.created_at) ?? change.updatedAt
    const updatedAt = this.optionalString(payload.updated_at) ?? change.updatedAt

    await this.driver.run(
      `INSERT INTO artists (id, name, normalized_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         normalized_name = excluded.normalized_name,
         updated_at = excluded.updated_at`,
      [id, name, normalizedName, createdAt, updatedAt]
    )
  }

  private async applyMusicItemUpsert(change: SyncPullResponse['changes'][number]): Promise<void> {
    const payload = change.payload
    const id = this.parseInteger(payload.id, 'music_item.id')
    const title = this.parseString(payload.title, 'music_item.title')
    const normalizedTitle = this.parseString(payload.normalized_title, 'music_item.normalized_title')
    const itemType = this.optionalString(payload.item_type) ?? 'album'
    const artistId = this.parseNullableInteger(payload.artist_id)
    const listenStatus = this.optionalString(payload.listen_status) ?? 'to-listen'
    const purchaseIntent = this.optionalString(payload.purchase_intent) ?? 'no'
    const priceCents = this.parseNullableInteger(payload.price_cents)
    const currency = this.optionalString(payload.currency) ?? 'USD'
    const notes = this.optionalString(payload.notes)
    const rating = this.parseNullableInteger(payload.rating)
    const createdAt = this.optionalString(payload.created_at) ?? change.updatedAt
    const updatedAt = this.optionalString(payload.updated_at) ?? change.updatedAt
    const listenedAt = this.optionalString(payload.listened_at)
    const isPhysical = this.parseInteger(payload.is_physical ?? 0, 'music_item.is_physical')
    const physicalFormat = this.optionalString(payload.physical_format)

    await this.driver.run(
      `INSERT INTO music_items (
          id, title, normalized_title, item_type, artist_id, listen_status, purchase_intent,
          price_cents, currency, notes, rating, created_at, updated_at, listened_at, is_physical, physical_format
        )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         normalized_title = excluded.normalized_title,
         item_type = excluded.item_type,
         artist_id = excluded.artist_id,
         listen_status = excluded.listen_status,
         purchase_intent = excluded.purchase_intent,
         price_cents = excluded.price_cents,
         currency = excluded.currency,
         notes = excluded.notes,
         rating = excluded.rating,
         updated_at = excluded.updated_at,
         listened_at = excluded.listened_at,
         is_physical = excluded.is_physical,
         physical_format = excluded.physical_format`,
      [
        id,
        title,
        normalizedTitle,
        itemType,
        artistId,
        listenStatus,
        purchaseIntent,
        priceCents,
        currency,
        notes,
        rating,
        createdAt,
        updatedAt,
        listenedAt,
        isPhysical,
        physicalFormat,
      ]
    )
  }

  private async applyMusicLinkUpsert(change: SyncPullResponse['changes'][number]): Promise<void> {
    const payload = change.payload
    const id = this.parseInteger(payload.id, 'music_link.id')
    const musicItemId = this.parseInteger(payload.music_item_id, 'music_link.music_item_id')
    const sourceId = this.parseNullableInteger(payload.source_id)
    const url = this.parseString(payload.url, 'music_link.url')
    const isPrimary = this.parseInteger(payload.is_primary ?? 0, 'music_link.is_primary')
    const createdAt = this.optionalString(payload.created_at) ?? change.updatedAt

    await this.driver.run(
      `INSERT INTO music_links (id, music_item_id, source_id, url, is_primary, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         music_item_id = excluded.music_item_id,
         source_id = excluded.source_id,
         url = excluded.url,
         is_primary = excluded.is_primary`,
      [id, musicItemId, sourceId, url, isPrimary, createdAt]
    )
  }

  private async deleteAppliedOps(opIds: string[]): Promise<void> {
    const placeholders = opIds.map(() => '?').join(', ')
    await this.driver.run(
      `DELETE FROM sync_outbox WHERE op_id IN (${placeholders})`,
      opIds
    )
  }

  private async markConflicts(conflicts: SyncPushResponse['conflicts']): Promise<void> {
    for (const conflict of conflicts) {
      await this.driver.run(
        `UPDATE sync_outbox
         SET attempts = attempts + 1,
             last_error = ?
         WHERE op_id = ?`,
        [conflict.reason, conflict.opId]
      )
    }
  }

  private async getCursor(): Promise<number> {
    const rows = await this.driver.query<SyncStateRow>(
      `SELECT value FROM sync_state WHERE key = 'cursor' LIMIT 1`
    )

    if (!rows[0]) return 0

    const parsed = Number(rows[0].value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
  }

  private async setCursor(version: number): Promise<void> {
    await this.driver.run(
      `INSERT INTO sync_state (key, value)
       VALUES ('cursor', ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = datetime('now')`,
      [String(version)]
    )
  }

  private createOpId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID()
    }

    const rand = Math.random().toString(36).slice(2)
    return `op_${Date.now()}_${rand}`
  }

  private parseInteger(value: unknown, fieldName: string): number {
    const parsed = typeof value === 'number' ? value : Number(value)
    if (!Number.isInteger(parsed)) {
      throw new Error(`Invalid integer for ${fieldName}`)
    }
    return parsed
  }

  private parseNullableInteger(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null
    return this.parseInteger(value, 'nullable integer')
  }

  private parseString(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`Invalid string for ${fieldName}`)
    }
    return value
  }

  private optionalString(value: unknown): string | null {
    if (value === null || value === undefined) return null
    if (typeof value !== 'string') return null
    return value
  }
}

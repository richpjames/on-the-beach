import type { IDatabaseDriver } from '../../../src/database/driver'

interface SyncOutboxRow {
  id: number
  op_id: string
  entity: string
  action: string
  payload_json: string
  client_updated_at: string
  attempts: number
  last_error: string | null
  created_at: string
}

interface SyncInboxRow {
  version: number
  entity: string
  entity_id: string
  action: string
  payload_json: string
  updated_at: string
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase()
}

export class FakeDriver implements IDatabaseDriver {
  private changeCallback: (() => void) | null = null
  private nextOutboxId = 1

  private syncOutbox: SyncOutboxRow[] = []
  private syncState = new Map<string, string>()
  private syncInbox = new Map<number, SyncInboxRow>()

  private artists = new Map<number, Record<string, unknown>>()
  private musicItems = new Map<number, Record<string, unknown>>()
  private musicLinks = new Map<number, Record<string, unknown>>()

  async initialize(): Promise<void> {}

  async close(): Promise<void> {}

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number; lastInsertRowId: number }> {
    const statement = normalizeSql(sql)

    if (statement.includes('insert into sync_outbox')) {
      const [opId, entity, action, payloadJson, clientUpdatedAt] = params as [string, string, string, string, string]
      if (this.syncOutbox.some((row) => row.op_id === opId)) {
        throw new Error(`UNIQUE constraint failed: sync_outbox.op_id (${opId})`)
      }

      const row: SyncOutboxRow = {
        id: this.nextOutboxId,
        op_id: opId,
        entity,
        action,
        payload_json: payloadJson,
        client_updated_at: clientUpdatedAt,
        attempts: 0,
        last_error: null,
        created_at: new Date().toISOString(),
      }

      this.syncOutbox.push(row)
      this.nextOutboxId += 1
      this.notifyChange()
      return { changes: 1, lastInsertRowId: row.id }
    }

    if (statement.includes('delete from sync_outbox where op_id in')) {
      const opIds = params as string[]
      const before = this.syncOutbox.length
      this.syncOutbox = this.syncOutbox.filter((row) => !opIds.includes(row.op_id))
      const changes = before - this.syncOutbox.length
      if (changes > 0) this.notifyChange()
      return { changes, lastInsertRowId: 0 }
    }

    if (statement.includes('update sync_outbox') && statement.includes('set attempts = attempts + 1')) {
      const [reason, opId] = params as [string, string]
      const row = this.syncOutbox.find((value) => value.op_id === opId)
      if (!row) return { changes: 0, lastInsertRowId: 0 }
      row.attempts += 1
      row.last_error = reason
      this.notifyChange()
      return { changes: 1, lastInsertRowId: 0 }
    }

    if (statement.includes('insert or replace into sync_inbox')) {
      const [version, entity, entityId, action, payloadJson, updatedAt] = params as [number, string, string, string, string, string]
      this.syncInbox.set(version, {
        version,
        entity,
        entity_id: entityId,
        action,
        payload_json: payloadJson,
        updated_at: updatedAt,
      })
      return { changes: 1, lastInsertRowId: version }
    }

    if (statement.includes('insert into sync_state') && statement.includes("values ('cursor', ?)")) {
      const [value] = params as [string]
      this.syncState.set('cursor', value)
      return { changes: 1, lastInsertRowId: 0 }
    }

    if (statement.includes('insert into artists')) {
      const [id, name, normalizedName, createdAt, updatedAt] = params as [number, string, string, string, string]
      this.artists.set(id, {
        id,
        name,
        normalized_name: normalizedName,
        created_at: createdAt,
        updated_at: updatedAt,
      })
      this.notifyChange()
      return { changes: 1, lastInsertRowId: id }
    }

    if (statement.includes('delete from artists where id = ?')) {
      const [id] = params as [number]
      const existed = this.artists.delete(id)
      if (existed) this.notifyChange()
      return { changes: existed ? 1 : 0, lastInsertRowId: 0 }
    }

    if (statement.includes('insert into music_items')) {
      const [
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
      ] = params

      this.musicItems.set(Number(id), {
        id: Number(id),
        title,
        normalized_title: normalizedTitle,
        item_type: itemType,
        artist_id: artistId,
        listen_status: listenStatus,
        purchase_intent: purchaseIntent,
        price_cents: priceCents,
        currency,
        notes,
        rating,
        created_at: createdAt,
        updated_at: updatedAt,
        listened_at: listenedAt,
        is_physical: isPhysical,
        physical_format: physicalFormat,
      })
      this.notifyChange()
      return { changes: 1, lastInsertRowId: Number(id) }
    }

    if (statement.includes('delete from music_items where id = ?')) {
      const [id] = params as [number]
      const existed = this.musicItems.delete(id)
      if (existed) this.notifyChange()
      return { changes: existed ? 1 : 0, lastInsertRowId: 0 }
    }

    if (statement.includes('insert into music_links')) {
      const [id, musicItemId, sourceId, url, isPrimary, createdAt] = params as [number, number, number | null, string, number, string]
      this.musicLinks.set(id, {
        id,
        music_item_id: musicItemId,
        source_id: sourceId,
        url,
        is_primary: isPrimary,
        created_at: createdAt,
      })
      this.notifyChange()
      return { changes: 1, lastInsertRowId: id }
    }

    if (statement.includes('delete from music_links where id = ?')) {
      const [id] = params as [number]
      const existed = this.musicLinks.delete(id)
      if (existed) this.notifyChange()
      return { changes: existed ? 1 : 0, lastInsertRowId: 0 }
    }

    throw new Error(`Unsupported SQL run statement in FakeDriver: ${sql}`)
  }

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    const statement = normalizeSql(sql)

    if (statement.includes('from sync_outbox')) {
      const limit = Number(params[0] ?? this.syncOutbox.length)
      const rows = this.syncOutbox
        .filter((row) => row.last_error === null)
        .sort((a, b) => a.id - b.id)
        .slice(0, limit)
        .map((row) => ({
          op_id: row.op_id,
          entity: row.entity,
          action: row.action,
          payload_json: row.payload_json,
          client_updated_at: row.client_updated_at,
        }))
      return rows as T[]
    }

    if (statement.includes("from sync_state where key = 'cursor'")) {
      const value = this.syncState.get('cursor')
      if (value === undefined) return []
      return [{ value }] as T[]
    }

    throw new Error(`Unsupported SQL query in FakeDriver: ${sql}`)
  }

  async exec(_sql: string): Promise<void> {
    // Schema/bootstrap statements are ignored for this test double.
  }

  async export(): Promise<Uint8Array> {
    return new Uint8Array()
  }

  async import(_data: Uint8Array): Promise<void> {}

  onChange(callback: () => void): void {
    this.changeCallback = callback
  }

  seedMusicItem(id: number, title: string): void {
    this.musicItems.set(id, {
      id,
      title,
      normalized_title: title.toLowerCase(),
      item_type: 'album',
      artist_id: null,
      listen_status: 'to-listen',
      purchase_intent: 'no',
      price_cents: null,
      currency: 'USD',
      notes: null,
      rating: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      listened_at: null,
      is_physical: 0,
      physical_format: null,
    })
  }

  hasMusicItem(id: number): boolean {
    return this.musicItems.has(id)
  }

  getMusicItemTitle(id: number): string | null {
    const item = this.musicItems.get(id)
    return typeof item?.title === 'string' ? item.title : null
  }

  getOutboxOpIds(): string[] {
    return this.syncOutbox.map((row) => row.op_id)
  }

  getOutboxRow(opId: string): { attempts: number; last_error: string | null } | null {
    const row = this.syncOutbox.find((value) => value.op_id === opId)
    if (!row) return null
    return { attempts: row.attempts, last_error: row.last_error }
  }

  getCursor(): number {
    const value = this.syncState.get('cursor')
    if (!value) return 0
    return Number(value)
  }

  private notifyChange(): void {
    this.changeCallback?.()
  }
}

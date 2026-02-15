import initSqlJs, { Database as SqlJsDatabase } from 'sql.js'

export interface IDatabaseDriver {
  initialize(): Promise<void>
  close(): Promise<void>
  run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowId: number }>
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>
  exec(sql: string): Promise<void>
  export(): Promise<Uint8Array>
  import(data: Uint8Array): Promise<void>
  onChange(callback: () => void): void
}

export class SqlJsDriver implements IDatabaseDriver {
  private db: SqlJsDatabase | null = null
  private SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null
  private onChangeCallback: (() => void) | null = null

  constructor(private wasmUrl: string = '/sql-wasm.wasm') {}

  async initialize(): Promise<void> {
    this.SQL = await initSqlJs({
      locateFile: () => this.wasmUrl,
    })
    this.db = new this.SQL.Database()
  }

  async close(): Promise<void> {
    this.db?.close()
    this.db = null
  }

  private getDb(): SqlJsDatabase {
    if (!this.db) throw new Error('Database not initialized')
    return this.db
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number; lastInsertRowId: number }> {
    const db = this.getDb()
    db.run(sql, params as (string | number | null | Uint8Array)[])

    const changes = db.getRowsModified()
    const result = db.exec('SELECT last_insert_rowid()')
    const lastInsertRowId = result[0]?.values[0]?.[0] as number ?? 0

    this.notifyChange()

    return { changes, lastInsertRowId }
  }

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    const db = this.getDb()
    const stmt = db.prepare(sql)
    stmt.bind(params as (string | number | null | Uint8Array)[])

    const results: T[] = []
    while (stmt.step()) {
      const row = stmt.getAsObject()
      results.push(row as T)
    }
    stmt.free()

    return results
  }

  async exec(sql: string): Promise<void> {
    const db = this.getDb()
    db.exec(sql)
    this.notifyChange()
  }

  async export(): Promise<Uint8Array> {
    return this.getDb().export()
  }

  async import(data: Uint8Array): Promise<void> {
    if (!this.SQL) throw new Error('SQL.js not initialized')
    this.db?.close()
    this.db = new this.SQL.Database(data)
  }

  onChange(callback: () => void): void {
    this.onChangeCallback = callback
  }

  private notifyChange(): void {
    this.onChangeCallback?.()
  }
}

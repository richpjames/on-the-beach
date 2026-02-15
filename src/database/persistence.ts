const DB_NAME = 'on-the-beach-db'
const STORE_NAME = 'sqlite-data'
const DATA_KEY = 'database'
const META_KEY = 'metadata'

export interface IPersistenceLayer {
  initialize(): Promise<void>
  save(data: Uint8Array): Promise<void>
  load(): Promise<Uint8Array | null>
  clear(): Promise<void>
}

export class IndexedDBPersistence implements IPersistenceLayer {
  private db: IDBDatabase | null = null

  async initialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1)

      request.onerror = () => reject(request.error)

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME)
        }
      }

      request.onsuccess = () => {
        this.db = request.result
        resolve()
      }
    })
  }

  async save(data: Uint8Array): Promise<void> {
    const db = this.getDb()

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)

      store.put(data, DATA_KEY)
      store.put({ savedAt: new Date().toISOString() }, META_KEY)

      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }

  async load(): Promise<Uint8Array | null> {
    const db = this.getDb()

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const request = store.get(DATA_KEY)

      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error)
    })
  }

  async clear(): Promise<void> {
    const db = this.getDb()

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      store.clear()

      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }

  private getDb(): IDBDatabase {
    if (!this.db) throw new Error('IndexedDB not initialized')
    return this.db
  }
}

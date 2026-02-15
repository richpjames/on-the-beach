import { SqlJsDriver } from './database/driver'
import { IndexedDBPersistence } from './database/persistence'
import { MusicRepository } from './repository/music-repository'
import { AutoSaveService } from './services/auto-save'
import { SyncService } from './services/sync'
import { AuthService } from './services/auth'
import type { SyncServiceConfig } from './services/sync'
import { SCHEMA } from './database/schema'
import type { MusicItemFull, ListenStatus, ItemType } from './types'

const STATUS_LABELS: Record<ListenStatus, string> = {
  'to-listen': 'To Listen',
  'listening': 'Listening',
  'listened': 'Listened',
  'to-revisit': 'Revisit',
  'done': 'Done',
}

interface AppOptions {
  sync?: {
    authService: AuthService
    config: SyncServiceConfig
    intervalMs?: number
  }
}

export class App {
  private driver: SqlJsDriver
  private persistence: IndexedDBPersistence
  private autoSave: AutoSaveService
  private repository: MusicRepository
  private currentFilter: ListenStatus | 'all' = 'all'
  private isReady = false
  private addFormInitialized = false
  private syncService: SyncService | null
  private syncIntervalMs: number
  private syncTimer: ReturnType<typeof setInterval> | null = null
  private syncInFlight = false

  constructor(options: AppOptions = {}) {
    this.driver = new SqlJsDriver('/sql-wasm.wasm')
    this.persistence = new IndexedDBPersistence()
    this.autoSave = new AutoSaveService(this.driver, this.persistence)
    this.repository = new MusicRepository(this.driver)
    if (options.sync) {
      this.syncService = new SyncService(this.driver, options.sync.authService, options.sync.config)
      this.syncIntervalMs = options.sync.intervalMs ?? 60_000
    } else {
      this.syncService = null
      this.syncIntervalMs = 60_000
    }
  }

  async initialize(): Promise<void> {
    // Bind the submit handler immediately so the form never falls back to native GET navigation.
    this.setupAddForm()

    // Initialize persistence
    await this.persistence.initialize()

    // Initialize SQL.js driver
    await this.driver.initialize()

    // Try to load existing database
    const existingData = await this.persistence.load()
    if (existingData) {
      await this.driver.import(existingData)
      console.log('[App] Loaded existing database from IndexedDB')
    } else {
      // Fresh database - run schema
      await this.driver.exec(SCHEMA)
      console.log('[App] Created new database')
    }

    // Initialize repository
    await this.repository.initialize()

    // Start auto-save
    this.autoSave.start()
    this.isReady = true

    // Initialize UI
    this.initializeUI()
    await this.runSyncCycle()
    this.startSyncLoop()
  }

  async forceSave(): Promise<void> {
    await this.autoSave.forceSave()
  }

  private initializeUI(): void {
    this.setupFilterBar()
    this.setupEventDelegation()
    this.renderMusicList()
  }

  private setupAddForm(): void {
    if (this.addFormInitialized) return

    const form = document.getElementById('add-form') as HTMLFormElement
    this.addFormInitialized = true

    form.addEventListener('submit', async (e) => {
      e.preventDefault()

      if (!this.isReady) {
        alert('App is still loading. Please try again in a moment.')
        return
      }

      const formData = new FormData(form)
      const url = formData.get('url') as string
      const title = formData.get('title') as string || undefined
      const artist = formData.get('artist') as string || undefined
      const itemType = formData.get('itemType') as ItemType || 'album'

      if (!url.trim()) return

      try {
        const item = await this.repository.createMusicItem({
          url,
          title: title || undefined,
          artistName: artist,
          itemType,
        })
        await this.queueMusicItemUpsert(item)
        await this.queuePrimaryMusicLinkUpsert(item)
        form.reset()
        await this.renderMusicList()
      } catch (error) {
        console.error('Failed to add item:', error)
        alert('Failed to add item. Please check the URL and try again.')
      }
    })
  }

  private startSyncLoop(): void {
    if (!this.syncService) return

    window.addEventListener('online', () => {
      void this.runSyncCycle()
    })

    if (this.syncIntervalMs > 0) {
      this.syncTimer = setInterval(() => {
        void this.runSyncCycle()
      }, this.syncIntervalMs)
    }
  }

  private async runSyncCycle(): Promise<void> {
    if (!this.syncService || this.syncInFlight) return

    this.syncInFlight = true
    try {
      const result = await this.syncService.runOnce()
      if (result.status === 'ok' && result.pulled > 0) {
        await this.renderMusicList()
      }
    } catch (error) {
      console.error('[Sync] Cycle failed:', error)
    } finally {
      this.syncInFlight = false
    }
  }

  private setupFilterBar(): void {
    const filterBar = document.getElementById('filter-bar')
    if (!filterBar) return

    filterBar.addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      if (!target.classList.contains('filter-btn')) return

      // Update active state
      filterBar.querySelectorAll('.filter-btn').forEach((btn) => {
        btn.classList.remove('active')
      })
      target.classList.add('active')

      // Set filter and re-render
      this.currentFilter = target.dataset.filter as ListenStatus | 'all'
      this.renderMusicList()
    })
  }

  private setupEventDelegation(): void {
    const list = document.getElementById('music-list')
    if (!list) return

    list.addEventListener('click', async (e) => {
      const target = e.target as HTMLElement

      // Delete button
      if (target.dataset.action === 'delete') {
        const card = target.closest('[data-item-id]') as HTMLElement
        const id = Number(card?.dataset.itemId)
        if (id && confirm('Delete this item?')) {
          const deleted = await this.repository.deleteMusicItem(id)
          if (deleted) {
            await this.queueMusicItemDelete(id)
          }
          await this.renderMusicList()
        }
      }
    })

    list.addEventListener('change', async (e) => {
      const target = e.target as HTMLSelectElement

      // Status select
      if (target.classList.contains('status-select')) {
        const card = target.closest('[data-item-id]') as HTMLElement
        const id = Number(card?.dataset.itemId)
        const status = target.value as ListenStatus
        if (id) {
          const updated = await this.repository.updateListenStatus(id, status)
          if (updated) {
            await this.queueMusicItemUpsert(updated)
          }
          await this.renderMusicList()
        }
      }
    })
  }

  private async renderMusicList(): Promise<void> {
    const container = document.getElementById('music-list')!

    const filters = this.currentFilter !== 'all'
      ? { listenStatus: this.currentFilter }
      : undefined

    const result = await this.repository.listMusicItems(filters)

    if (result.items.length === 0) {
      const message = this.currentFilter === 'all'
        ? 'No music tracked yet. Paste a link above to get started!'
        : `No items with status "${STATUS_LABELS[this.currentFilter as ListenStatus]}"`
      container.innerHTML = `
        <div class="empty-state">
          <p>${message}</p>
        </div>
      `
      return
    }

    container.innerHTML = result.items.map((item) => this.renderMusicCard(item)).join('')
  }

  private async queueMusicItemUpsert(item: MusicItemFull): Promise<void> {
    if (!this.syncService) return

    try {
      await this.syncService.queueOperation({
        entity: 'music_item',
        action: 'upsert',
        payload: {
          id: String(item.id),
          title: item.title,
          normalized_title: item.normalized_title,
          item_type: item.item_type,
          artist_id: item.artist_id,
          listen_status: item.listen_status,
          purchase_intent: item.purchase_intent,
          price_cents: item.price_cents,
          currency: item.currency,
          notes: item.notes,
          rating: item.rating,
          created_at: item.created_at,
          updated_at: item.updated_at,
          listened_at: item.listened_at,
          is_physical: item.is_physical,
          physical_format: item.physical_format,
        },
      })
      void this.runSyncCycle()
    } catch (error) {
      console.error('[Sync] Failed to queue music item upsert:', error)
    }
  }

  private async queueMusicItemDelete(id: number): Promise<void> {
    if (!this.syncService) return

    try {
      await this.syncService.queueOperation({
        entity: 'music_item',
        action: 'delete',
        payload: {
          id: String(id),
          deletedAt: new Date().toISOString(),
        },
      })
      void this.runSyncCycle()
    } catch (error) {
      console.error('[Sync] Failed to queue music item delete:', error)
    }
  }

  private async queuePrimaryMusicLinkUpsert(item: MusicItemFull): Promise<void> {
    if (!this.syncService || !item.primary_url) return

    try {
      await this.syncService.queueOperation({
        entity: 'music_link',
        action: 'upsert',
        payload: {
          id: `primary:${item.id}`,
          music_item_id: String(item.id),
          url: item.primary_url,
          is_primary: 1,
          source_name: item.primary_source,
          created_at: item.created_at,
        },
      })
      void this.runSyncCycle()
    } catch (error) {
      console.error('[Sync] Failed to queue primary music link upsert:', error)
    }
  }

  private renderMusicCard(item: MusicItemFull): string {
    const statusOptions = Object.entries(STATUS_LABELS)
      .map(([value, label]) =>
        `<option value="${value}" ${item.listen_status === value ? 'selected' : ''}>${label}</option>`
      )
      .join('')

    return `
      <article class="music-card" data-item-id="${item.id}">
        <div class="music-card__content">
          <div class="music-card__title">${this.escapeHtml(item.title)}</div>
          ${item.artist_name ? `<div class="music-card__artist">${this.escapeHtml(item.artist_name)}</div>` : ''}
          <div class="music-card__meta">
            <select class="status-select">${statusOptions}</select>
            ${item.primary_source ? (
              item.primary_url
                ? `<a href="${this.escapeHtml(item.primary_url)}" target="_blank" rel="noopener noreferrer" class="badge badge--source">${this.escapeHtml(item.primary_source)}</a>`
                : `<span class="badge badge--source">${this.escapeHtml(item.primary_source)}</span>`
            ) : ''}
          </div>
        </div>
        <div class="music-card__actions">
          ${item.primary_url ? `
            <a href="${this.escapeHtml(item.primary_url)}" target="_blank" rel="noopener noreferrer" class="btn btn--ghost" title="Open link">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                <polyline points="15 3 21 3 21 9"></polyline>
                <line x1="10" y1="14" x2="21" y2="3"></line>
              </svg>
            </a>
          ` : ''}
          <button class="btn btn--ghost btn--danger" data-action="delete" title="Delete">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </div>
      </article>
    `
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }
}

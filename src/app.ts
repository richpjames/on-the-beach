import { SqlJsDriver } from './database/driver'
import { IndexedDBPersistence } from './database/persistence'
import { MusicRepository } from './repository/music-repository'
import { StackRepository } from './repository/stack-repository'
import { AutoSaveService } from './services/auto-save'
import { SyncService } from './services/sync'
import { AuthService } from './services/auth'
import type { SyncServiceConfig } from './services/sync'
import { SCHEMA } from './database/schema'
import type { MusicItemFull, ListenStatus, ItemType, Stack, StackWithCount, MusicItemFilters } from './types'

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
  private currentStack: number | null = null
  private stackRepository!: StackRepository
  private stacks: StackWithCount[] = []
  private isReady = false
  private addFormInitialized = false
  private addFormSelectedStacks: number[] = []
  private syncService: SyncService | null
  private syncIntervalMs: number
  private syncTimer: ReturnType<typeof setInterval> | null = null
  private syncInFlight = false

  constructor(options: AppOptions = {}) {
    this.driver = new SqlJsDriver('/sql-wasm.wasm')
    this.persistence = new IndexedDBPersistence()
    this.autoSave = new AutoSaveService(this.driver, this.persistence)
    this.repository = new MusicRepository(this.driver)
    this.stackRepository = new StackRepository(this.driver)
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
    this.setupStackBar()
    this.setupEventDelegation()
    this.renderStackBar()
    this.renderMusicList()
  }

  private setupAddForm(): void {
    if (this.addFormInitialized) return

    const form = document.getElementById('add-form') as HTMLFormElement
    this.addFormInitialized = true

    // Stack picker button
    document.getElementById('add-form-stack-btn')?.addEventListener('click', () => {
      this.showAddFormStackDropdown()
    })

    // Stack chip removal
    document.getElementById('add-form-stack-chips')?.addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      if (target.dataset.removeStack) {
        this.addFormSelectedStacks = this.addFormSelectedStacks.filter(
          id => id !== Number(target.dataset.removeStack)
        )
        this.renderAddFormStackChips()
      }
    })

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
        // Assign selected stacks
        if (this.addFormSelectedStacks.length > 0) {
          await this.stackRepository.setItemStacks(item.id, this.addFormSelectedStacks)
          this.addFormSelectedStacks = []
          this.renderAddFormStackChips()
          await this.renderStackBar()
        }
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

  private async renderStackBar(): Promise<void> {
    this.stacks = await this.stackRepository.listStacks()
    const bar = document.getElementById('stack-bar')!
    const allBtn = bar.querySelector('[data-stack="all"]')!
    const manageBtn = document.getElementById('manage-stacks-btn')!

    // Remove old dynamic tabs
    bar.querySelectorAll('.stack-tab[data-stack-id]').forEach(el => el.remove())

    // Insert stack tabs before the manage button
    for (const stack of this.stacks) {
      const btn = document.createElement('button')
      btn.className = `stack-tab${this.currentStack === stack.id ? ' active' : ''}`
      btn.dataset.stackId = String(stack.id)
      btn.textContent = stack.name
      bar.insertBefore(btn, manageBtn)
    }

    // Update active state on All button
    allBtn.className = `stack-tab${this.currentStack === null ? ' active' : ''}`
  }

  private setupStackBar(): void {
    const bar = document.getElementById('stack-bar')
    if (!bar) return

    bar.addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      const tab = target.closest('.stack-tab') as HTMLElement | null
      if (!tab || tab.id === 'manage-stacks-btn') return

      if (tab.dataset.stack === 'all') {
        this.currentStack = null
      } else if (tab.dataset.stackId) {
        this.currentStack = Number(tab.dataset.stackId)
      }

      this.renderStackBar()
      this.renderMusicList()
    })
  }

  private setupEventDelegation(): void {
    const list = document.getElementById('music-list')
    if (!list) return

    list.addEventListener('click', async (e) => {
      const target = e.target as HTMLElement

      // Stack dropdown
      if (target.dataset.action === 'stack' || target.closest('[data-action="stack"]')) {
        const card = target.closest('[data-item-id]') as HTMLElement
        const id = Number(card?.dataset.itemId)
        if (id) {
          await this.renderStackDropdown(card, id)
        }
        return
      }

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

    const filters: MusicItemFilters = {}
    if (this.currentFilter !== 'all') {
      filters.listenStatus = this.currentFilter
    }
    if (this.currentStack !== null) {
      filters.stackId = this.currentStack
    }
    const hasFilters = Object.keys(filters).length > 0
    const result = await this.repository.listMusicItems(hasFilters ? filters : undefined)

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
          <button class="btn btn--ghost" data-action="stack" title="Manage stacks">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </button>
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

  private renderAddFormStackChips(): void {
    const container = document.getElementById('add-form-stack-chips')
    if (!container) return
    container.innerHTML = this.addFormSelectedStacks
      .map(id => {
        const stack = this.stacks.find(s => s.id === id)
        if (!stack) return ''
        return `<span class="stack-chip">
          ${this.escapeHtml(stack.name)}
          <button type="button" class="stack-chip__remove" data-remove-stack="${id}">&times;</button>
        </span>`
      })
      .join('')
  }

  private async showAddFormStackDropdown(): Promise<void> {
    document.querySelectorAll('.stack-dropdown').forEach(el => el.remove())

    const stacks = await this.stackRepository.listStacks()
    const selectedSet = new Set(this.addFormSelectedStacks)

    const dropdown = document.createElement('div')
    dropdown.className = 'stack-dropdown'
    dropdown.innerHTML = `
      ${stacks.map(s => `
        <label class="stack-dropdown__item">
          <input type="checkbox" class="stack-dropdown__checkbox"
                 data-stack-id="${s.id}" ${selectedSet.has(s.id) ? 'checked' : ''}>
          ${this.escapeHtml(s.name)}
        </label>
      `).join('')}
      <div class="stack-dropdown__new">
        <input type="text" class="stack-dropdown__new-input input"
               placeholder="New stack...">
      </div>
    `

    const picker = document.getElementById('add-form-stacks')!
    picker.appendChild(dropdown)

    dropdown.addEventListener('change', async (e) => {
      const target = e.target as HTMLInputElement
      if (!target.classList.contains('stack-dropdown__checkbox')) return
      const stackId = Number(target.dataset.stackId)
      if (target.checked) {
        if (!this.addFormSelectedStacks.includes(stackId)) {
          this.addFormSelectedStacks.push(stackId)
        }
      } else {
        this.addFormSelectedStacks = this.addFormSelectedStacks.filter(id => id !== stackId)
      }
      this.renderAddFormStackChips()
    })

    const newInput = dropdown.querySelector('.stack-dropdown__new-input') as HTMLInputElement
    newInput.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      const name = newInput.value.trim()
      if (!name) return
      const stack = await this.stackRepository.createStack(name)
      this.addFormSelectedStacks.push(stack.id)
      await this.renderStackBar()
      this.renderAddFormStackChips()
      await this.showAddFormStackDropdown()
    })

    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dropdown.remove()
        document.removeEventListener('keydown', closeOnEscape)
      }
    }
    document.addEventListener('keydown', closeOnEscape)

    setTimeout(() => {
      const clickOutside = (e: MouseEvent) => {
        if (!dropdown.contains(e.target as Node) && !(e.target as HTMLElement).closest('#add-form-stack-btn')) {
          dropdown.remove()
          document.removeEventListener('click', clickOutside)
        }
      }
      document.addEventListener('click', clickOutside)
    }, 0)
  }

  private async renderStackDropdown(cardEl: HTMLElement, itemId: number): Promise<void> {
    // Remove any existing dropdown
    document.querySelectorAll('.stack-dropdown').forEach(el => el.remove())

    const stacks = await this.stackRepository.listStacks()
    const itemStacks = await this.stackRepository.getStacksForItem(itemId)
    const itemStackIds = new Set(itemStacks.map(s => s.id))

    const dropdown = document.createElement('div')
    dropdown.className = 'stack-dropdown'
    dropdown.innerHTML = `
      ${stacks.map(s => `
        <label class="stack-dropdown__item">
          <input type="checkbox" class="stack-dropdown__checkbox"
                 data-stack-id="${s.id}" ${itemStackIds.has(s.id) ? 'checked' : ''}>
          ${this.escapeHtml(s.name)}
        </label>
      `).join('')}
      <div class="stack-dropdown__new">
        <input type="text" class="stack-dropdown__new-input input"
               placeholder="New stack...">
      </div>
    `

    const actionsEl = cardEl.querySelector('.music-card__actions')!
    ;(actionsEl as HTMLElement).style.position = 'relative'
    actionsEl.appendChild(dropdown)

    // Handle checkbox toggles
    dropdown.addEventListener('change', async (e) => {
      const target = e.target as HTMLInputElement
      if (!target.classList.contains('stack-dropdown__checkbox')) return
      const stackId = Number(target.dataset.stackId)
      if (target.checked) {
        await this.stackRepository.addItemToStack(itemId, stackId)
      } else {
        await this.stackRepository.removeItemFromStack(itemId, stackId)
      }
      await this.renderStackBar()
    })

    // Handle new stack creation
    const newInput = dropdown.querySelector('.stack-dropdown__new-input') as HTMLInputElement
    newInput.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return
      const name = newInput.value.trim()
      if (!name) return
      const stack = await this.stackRepository.createStack(name)
      await this.stackRepository.addItemToStack(itemId, stack.id)
      await this.renderStackBar()
      await this.renderStackDropdown(cardEl, itemId)
    })

    // Close on Escape
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dropdown.remove()
        document.removeEventListener('keydown', closeOnEscape)
      }
    }
    document.addEventListener('keydown', closeOnEscape)

    // Close on outside click (setTimeout to avoid same click closing it)
    setTimeout(() => {
      const clickOutside = (e: MouseEvent) => {
        if (!dropdown.contains(e.target as Node)) {
          dropdown.remove()
          document.removeEventListener('click', clickOutside)
        }
      }
      document.addEventListener('click', clickOutside)
    }, 0)
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }
}

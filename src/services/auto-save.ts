import type { IDatabaseDriver } from '../database/driver'
import type { IPersistenceLayer } from '../database/persistence'

export class AutoSaveService {
  private saveTimeout: ReturnType<typeof setTimeout> | null = null
  private isSaving = false
  private pendingSave = false

  constructor(
    private driver: IDatabaseDriver,
    private persistence: IPersistenceLayer,
    private debounceMs: number = 1000
  ) {}

  start(): void {
    this.driver.onChange(() => this.scheduleSave())
  }

  stop(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout)
      this.saveTimeout = null
    }
  }

  private scheduleSave(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout)
    }
    this.saveTimeout = setTimeout(() => this.performSave(), this.debounceMs)
  }

  private async performSave(): Promise<void> {
    if (this.isSaving) {
      this.pendingSave = true
      return
    }

    this.isSaving = true

    try {
      const data = await this.driver.export()
      await this.persistence.save(data)
      console.log('[AutoSave] Database saved to IndexedDB')
    } catch (error) {
      console.error('[AutoSave] Failed to save:', error)
    } finally {
      this.isSaving = false

      if (this.pendingSave) {
        this.pendingSave = false
        this.scheduleSave()
      }
    }
  }

  async forceSave(): Promise<void> {
    this.stop()
    await this.performSave()
  }
}

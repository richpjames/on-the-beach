# Stacks Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add user-created stacks (tags) for organizing music links, with tab navigation, card assignment, add-form integration, and management UI.

**Architecture:** Two new SQL tables (stacks + junction), a new StackRepository class, and UI additions to app.ts (stack tabs, card dropdown, add-form chips, management panel). All client-side, same patterns as existing code.

**Tech Stack:** TypeScript, sql.js (SQLite in browser), vanilla DOM, Playwright e2e tests

---

### Task 1: Schema — Add stacks tables

**Files:**
- Modify: `src/database/schema.ts`

**Step 1: Add the two new tables and index to the schema string**

In `src/database/schema.ts`, add the following SQL *before* the `-- View for full music items` comment (line 75):

```sql
-- Stacks: User-created categories for organizing music
CREATE TABLE IF NOT EXISTS stacks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Junction table: Many-to-many relationship between music items and stacks
CREATE TABLE IF NOT EXISTS music_item_stacks (
    music_item_id INTEGER NOT NULL REFERENCES music_items(id) ON DELETE CASCADE,
    stack_id INTEGER NOT NULL REFERENCES stacks(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (music_item_id, stack_id)
);

CREATE INDEX IF NOT EXISTS idx_music_item_stacks_stack_id ON music_item_stacks(stack_id);
CREATE INDEX IF NOT EXISTS idx_music_item_stacks_music_item_id ON music_item_stacks(music_item_id);
```

**Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No errors

**Step 3: Verify e2e tests still pass**

Run: `npx playwright test`
Expected: All existing tests pass (schema is additive, nothing breaks)

**Step 4: Commit**

```bash
git add src/database/schema.ts
git commit -m "feat: add stacks and music_item_stacks tables to schema"
```

---

### Task 2: Types — Add Stack types

**Files:**
- Modify: `src/types/index.ts`

**Step 1: Add Stack interfaces and update filters**

At the end of `src/types/index.ts`, add:

```typescript
// Stacks
export interface Stack {
  id: number
  name: string
  created_at: string
}

export interface StackWithCount extends Stack {
  item_count: number
}
```

Also update `MusicItemFilters` (around line 96) to add a `stackId` filter:

```typescript
export interface MusicItemFilters {
  listenStatus?: ListenStatus | ListenStatus[]
  purchaseIntent?: PurchaseIntent | PurchaseIntent[]
  search?: string
  stackId?: number
}
```

**Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No errors

**Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: add Stack types and stackId filter"
```

---

### Task 3: Repository — Stack CRUD operations

**Files:**
- Create: `src/repository/stack-repository.ts`

**Step 1: Create the stack repository**

Create `src/repository/stack-repository.ts`:

```typescript
import type { IDatabaseDriver } from '../database/driver'
import type { Stack, StackWithCount } from '../types'

export interface IStackRepository {
  createStack(name: string): Promise<Stack>
  renameStack(id: number, name: string): Promise<Stack | null>
  deleteStack(id: number): Promise<boolean>
  listStacks(): Promise<StackWithCount[]>
  getStacksForItem(musicItemId: number): Promise<Stack[]>
  addItemToStack(musicItemId: number, stackId: number): Promise<void>
  removeItemFromStack(musicItemId: number, stackId: number): Promise<void>
  setItemStacks(musicItemId: number, stackIds: number[]): Promise<void>
}

export class StackRepository implements IStackRepository {
  constructor(private driver: IDatabaseDriver) {}

  async createStack(name: string): Promise<Stack> {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Stack name cannot be empty')

    const { lastInsertRowId } = await this.driver.run(
      `INSERT INTO stacks (name) VALUES (?)`,
      [trimmed]
    )

    const stacks = await this.driver.query<Stack>(
      `SELECT * FROM stacks WHERE id = ?`,
      [lastInsertRowId]
    )
    return stacks[0]
  }

  async renameStack(id: number, name: string): Promise<Stack | null> {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Stack name cannot be empty')

    await this.driver.run(
      `UPDATE stacks SET name = ? WHERE id = ?`,
      [trimmed, id]
    )

    const stacks = await this.driver.query<Stack>(
      `SELECT * FROM stacks WHERE id = ?`,
      [id]
    )
    return stacks[0] || null
  }

  async deleteStack(id: number): Promise<boolean> {
    const { changes } = await this.driver.run(
      `DELETE FROM stacks WHERE id = ?`,
      [id]
    )
    return changes > 0
  }

  async listStacks(): Promise<StackWithCount[]> {
    return this.driver.query<StackWithCount>(
      `SELECT s.*, COUNT(mis.music_item_id) AS item_count
       FROM stacks s
       LEFT JOIN music_item_stacks mis ON s.id = mis.stack_id
       GROUP BY s.id
       ORDER BY s.name ASC`
    )
  }

  async getStacksForItem(musicItemId: number): Promise<Stack[]> {
    return this.driver.query<Stack>(
      `SELECT s.* FROM stacks s
       JOIN music_item_stacks mis ON s.id = mis.stack_id
       WHERE mis.music_item_id = ?
       ORDER BY s.name ASC`,
      [musicItemId]
    )
  }

  async addItemToStack(musicItemId: number, stackId: number): Promise<void> {
    await this.driver.run(
      `INSERT OR IGNORE INTO music_item_stacks (music_item_id, stack_id) VALUES (?, ?)`,
      [musicItemId, stackId]
    )
  }

  async removeItemFromStack(musicItemId: number, stackId: number): Promise<void> {
    await this.driver.run(
      `DELETE FROM music_item_stacks WHERE music_item_id = ? AND stack_id = ?`,
      [musicItemId, stackId]
    )
  }

  async setItemStacks(musicItemId: number, stackIds: number[]): Promise<void> {
    await this.driver.run(
      `DELETE FROM music_item_stacks WHERE music_item_id = ?`,
      [musicItemId]
    )

    for (const stackId of stackIds) {
      await this.driver.run(
        `INSERT INTO music_item_stacks (music_item_id, stack_id) VALUES (?, ?)`,
        [musicItemId, stackId]
      )
    }
  }
}
```

**Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No errors

**Step 3: Commit**

```bash
git add src/repository/stack-repository.ts
git commit -m "feat: add StackRepository with CRUD and assignment operations"
```

---

### Task 4: Repository — Wire stack filter into music item queries

**Files:**
- Modify: `src/repository/music-repository.ts`

**Step 1: Add stackId filter to listMusicItems**

In `music-repository.ts`, the `listMusicItems` method (line 149) builds `conditions` and `params`. Add a new condition block after the `search` filter (after line 174):

```typescript
    if (filters?.stackId) {
      conditions.push(
        `id IN (SELECT music_item_id FROM music_item_stacks WHERE stack_id = ?)`
      )
      params.push(filters.stackId)
    }
```

**Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No errors

**Step 3: Verify existing e2e tests still pass**

Run: `npx playwright test`
Expected: All existing tests pass

**Step 4: Commit**

```bash
git add src/repository/music-repository.ts
git commit -m "feat: add stackId filter to listMusicItems query"
```

---

### Task 5: UI — Stack tab navigation

**Files:**
- Modify: `index.html`
- Modify: `src/app.ts`
- Modify: `src/styles/main.css`

**Step 1: Add stack bar HTML**

In `index.html`, add a new section *before* the `filter-section` (before line 49):

```html
      <section class="stack-section">
        <div id="stack-bar" class="stack-bar">
          <button class="stack-tab active" data-stack="all">All</button>
          <!-- Stack tabs inserted by JS -->
          <button class="stack-tab stack-tab--manage" id="manage-stacks-btn" title="Manage stacks">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
          </button>
        </div>
      </section>
```

**Step 2: Add stack bar CSS**

In `src/styles/main.css`, add after the filter bar styles (after line 169):

```css
/* Stack bar */
.stack-section {
  margin-bottom: 1rem;
}

.stack-bar {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  align-items: center;
}

.stack-tab {
  padding: 0.5rem 1rem;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text-muted);
  font-size: 0.875rem;
  cursor: pointer;
  transition: all 0.15s;
}

.stack-tab:hover {
  border-color: var(--text-muted);
}

.stack-tab.active {
  background: var(--accent);
  border-color: var(--accent);
  color: white;
}

.stack-tab--manage {
  padding: 0.5rem;
  margin-left: auto;
}
```

**Step 3: Wire up stack state and rendering in app.ts**

In `src/app.ts`:

a) Add imports — add `StackRepository` import near the top and import new types:

```typescript
import { StackRepository } from './repository/stack-repository'
import type { MusicItemFull, ListenStatus, ItemType, Stack, StackWithCount } from './types'
```

b) Add instance variables to the `App` class (after `currentFilter` on line 32):

```typescript
  private currentStack: number | null = null  // null = "All"
  private stackRepository: StackRepository
  private stacks: StackWithCount[] = []
```

c) Initialize `stackRepository` in the constructor (after `this.repository = ...` on line 44):

```typescript
    this.stackRepository = new StackRepository(this.driver)
```

d) Add `renderStackBar` method:

```typescript
  private async renderStackBar(): Promise<void> {
    this.stacks = await this.stackRepository.listStacks()
    const bar = document.getElementById('stack-bar')!

    // Keep the "All" button and gear button, replace dynamic tabs
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
```

e) Add `setupStackBar` method:

```typescript
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
```

f) Call `setupStackBar()` in `initializeUI()` (before `renderMusicList()`):

```typescript
    this.setupStackBar()
```

g) Call `renderStackBar()` in `initializeUI()` (before `renderMusicList()`):

```typescript
    this.renderStackBar()
```

h) Update `renderMusicList` to use `currentStack`. Change the filters building (around line 231):

```typescript
    const filters: MusicItemFilters = {}
    if (this.currentFilter !== 'all') {
      filters.listenStatus = this.currentFilter
    }
    if (this.currentStack !== null) {
      filters.stackId = this.currentStack
    }
    const result = await this.repository.listMusicItems(Object.keys(filters).length ? filters : undefined)
```

(Remember to import `MusicItemFilters` at the top.)

**Step 4: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No errors

**Step 5: Verify e2e tests still pass**

Run: `npx playwright test`
Expected: All existing tests pass

**Step 6: Commit**

```bash
git add index.html src/app.ts src/styles/main.css
git commit -m "feat: add stack tab navigation UI"
```

---

### Task 6: UI — Card stack dropdown (assign items to stacks)

**Files:**
- Modify: `src/app.ts`
- Modify: `src/styles/main.css`

**Step 1: Write the e2e test**

Create `playwright/stacks.spec.ts`:

```typescript
import { expect, test } from '@playwright/test'

test.describe('Stacks', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByPlaceholder('Paste a music link...')).toBeVisible()
  })

  test('can create a stack and assign a link to it', async ({ page }) => {
    // Add a link
    await page.getByPlaceholder('Paste a music link...').fill(
      'https://seekersinternational.bandcamp.com/album/test-album'
    )
    await page.getByRole('button', { name: 'Add' }).click()
    await expect(page.locator('.music-card').first()).toBeVisible({ timeout: 10_000 })

    // Open stack dropdown on the card
    await page.locator('.music-card').first().locator('[data-action="stack"]').click()
    await expect(page.locator('.stack-dropdown')).toBeVisible()

    // Create a new stack inline
    await page.locator('.stack-dropdown__new-input').fill('Salsa')
    await page.locator('.stack-dropdown__new-input').press('Enter')

    // Verify stack tab appears
    await expect(page.locator('.stack-tab', { hasText: 'Salsa' })).toBeVisible()

    // Verify checkbox is checked
    await expect(page.locator('.stack-dropdown__checkbox:checked')).toBeVisible()

    // Close dropdown
    await page.keyboard.press('Escape')

    // Click the Salsa tab
    await page.locator('.stack-tab', { hasText: 'Salsa' }).click()

    // Card should still be visible (it's in the Salsa stack)
    await expect(page.locator('.music-card').first()).toBeVisible()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx playwright test playwright/stacks.spec.ts`
Expected: FAIL — no `[data-action="stack"]` button exists yet

**Step 3: Add "+ Stack" button to card rendering**

In `src/app.ts`, in the `renderMusicCard` method, add a button inside `.music-card__actions` (before the delete button):

```html
          <button class="btn btn--ghost" data-action="stack" title="Manage stacks">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </button>
```

**Step 4: Add dropdown rendering and event handling**

In `src/app.ts`, add a method to render the dropdown:

```typescript
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

    // Position relative to the button
    const actionsEl = cardEl.querySelector('.music-card__actions')!
    actionsEl.style.position = 'relative'
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
      await this.renderStackDropdown(cardEl, itemId) // Re-render dropdown
    })

    // Close on Escape
    const closeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dropdown.remove()
        document.removeEventListener('keydown', closeHandler)
      }
    }
    document.addEventListener('keydown', closeHandler)

    // Close on outside click
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
```

**Step 5: Wire up the stack button click in `setupEventDelegation`**

In the click handler of `setupEventDelegation`, add before the delete handler:

```typescript
      // Stack dropdown
      if (target.dataset.action === 'stack' || target.closest('[data-action="stack"]')) {
        const card = (target.closest('[data-item-id]')) as HTMLElement
        const id = Number(card?.dataset.itemId)
        if (id) {
          await this.renderStackDropdown(card, id)
        }
        return
      }
```

**Step 6: Add dropdown CSS**

In `src/styles/main.css`:

```css
/* Stack dropdown */
.stack-dropdown {
  position: absolute;
  top: 100%;
  right: 0;
  z-index: 10;
  min-width: 180px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.stack-dropdown__item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.35rem 0.5rem;
  border-radius: var(--radius-sm);
  font-size: 0.875rem;
  cursor: pointer;
  color: var(--text);
}

.stack-dropdown__item:hover {
  background: var(--bg-input);
}

.stack-dropdown__new {
  border-top: 1px solid var(--border);
  padding-top: 0.5rem;
  margin-top: 0.25rem;
}

.stack-dropdown__new-input {
  width: 100%;
  padding: 0.35rem 0.5rem;
  font-size: 0.875rem;
}
```

**Step 7: Run e2e test**

Run: `npx playwright test playwright/stacks.spec.ts`
Expected: PASS

**Step 8: Run all e2e tests**

Run: `npx playwright test`
Expected: All tests pass

**Step 9: Commit**

```bash
git add src/app.ts src/styles/main.css playwright/stacks.spec.ts
git commit -m "feat: add stack assignment dropdown on music cards"
```

---

### Task 7: UI — Add form stack selection

**Files:**
- Modify: `index.html`
- Modify: `src/app.ts`
- Modify: `src/styles/main.css`

**Step 1: Add stack picker to the add form HTML**

In `index.html`, inside `.add-form__extra` (after the `select` on line 43), add:

```html
              <div class="stack-picker" id="add-form-stacks">
                <div class="stack-picker__chips" id="add-form-stack-chips"></div>
                <button type="button" class="stack-picker__add btn btn--ghost" id="add-form-stack-btn">+ Stack</button>
              </div>
```

**Step 2: Add stack picker CSS**

In `src/styles/main.css`:

```css
/* Stack picker (add form) */
.stack-picker {
  grid-column: span 2;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  position: relative;
}

.stack-picker__chips {
  display: flex;
  gap: 0.25rem;
  flex-wrap: wrap;
}

.stack-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem 0.5rem;
  background: rgba(59, 130, 246, 0.2);
  color: #60a5fa;
  border-radius: var(--radius-sm);
  font-size: 0.75rem;
}

.stack-chip__remove {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  padding: 0;
  font-size: 1rem;
  line-height: 1;
  opacity: 0.7;
}

.stack-chip__remove:hover {
  opacity: 1;
}

.stack-picker__add {
  font-size: 0.875rem;
  padding: 0.25rem 0.5rem;
}
```

**Step 3: Wire up the add-form stack picker in app.ts**

Add state for selected stacks in the add form:

```typescript
  private addFormSelectedStacks: number[] = []
```

Add a method to render the add-form chips:

```typescript
  private renderAddFormStackChips(): void {
    const container = document.getElementById('add-form-stack-chips')!
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
```

Add a method to show the stack dropdown on the add form (reuses the same dropdown pattern):

```typescript
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
      await this.showAddFormStackDropdown() // Re-render dropdown
    })

    const closeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dropdown.remove()
        document.removeEventListener('keydown', closeHandler)
      }
    }
    document.addEventListener('keydown', closeHandler)

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
```

**Step 4: Wire up event listeners in setupAddForm**

In `setupAddForm`, add after `this.addFormInitialized = true`:

```typescript
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
```

**Step 5: Assign stacks after item creation**

In the form submit handler, after `await this.repository.createMusicItem(...)` and before `form.reset()`, add:

```typescript
        // Assign selected stacks
        if (this.addFormSelectedStacks.length > 0) {
          await this.stackRepository.setItemStacks(item.id, this.addFormSelectedStacks)
          this.addFormSelectedStacks = []
          this.renderAddFormStackChips()
          await this.renderStackBar()
        }
```

Also reset stacks on form reset:

```typescript
        this.addFormSelectedStacks = []
        this.renderAddFormStackChips()
```

**Step 6: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No errors

**Step 7: Verify all e2e tests pass**

Run: `npx playwright test`
Expected: All tests pass

**Step 8: Commit**

```bash
git add index.html src/app.ts src/styles/main.css
git commit -m "feat: add stack selection to the add form"
```

---

### Task 8: UI — Stack management panel

**Files:**
- Modify: `index.html`
- Modify: `src/app.ts`
- Modify: `src/styles/main.css`

**Step 1: Write the e2e test**

Add to `playwright/stacks.spec.ts`:

```typescript
  test('can rename and delete a stack from the management panel', async ({ page }) => {
    // Add a link and create a stack first
    await page.getByPlaceholder('Paste a music link...').fill(
      'https://seekersinternational.bandcamp.com/album/manage-test'
    )
    await page.getByRole('button', { name: 'Add' }).click()
    await expect(page.locator('.music-card').first()).toBeVisible({ timeout: 10_000 })

    // Create stack via card dropdown
    await page.locator('.music-card').first().locator('[data-action="stack"]').click()
    await page.locator('.stack-dropdown__new-input').fill('OldName')
    await page.locator('.stack-dropdown__new-input').press('Enter')
    await page.keyboard.press('Escape')
    await expect(page.locator('.stack-tab', { hasText: 'OldName' })).toBeVisible()

    // Open management panel
    await page.locator('#manage-stacks-btn').click()
    await expect(page.locator('.stack-manage')).toBeVisible()

    // Rename
    await page.locator('.stack-manage__rename-btn').first().click()
    await page.locator('.stack-manage__rename-input').fill('NewName')
    await page.locator('.stack-manage__rename-confirm').click()
    await expect(page.locator('.stack-tab', { hasText: 'NewName' })).toBeVisible()

    // Delete
    page.on('dialog', dialog => dialog.accept())
    await page.locator('.stack-manage__delete-btn').first().click()
    await expect(page.locator('.stack-tab', { hasText: 'NewName' })).not.toBeVisible()
  })
```

**Step 2: Run test to verify it fails**

Run: `npx playwright test playwright/stacks.spec.ts -g "rename and delete"`
Expected: FAIL

**Step 3: Add management panel HTML**

In `index.html`, inside `.stack-section` after the `stack-bar` div:

```html
        <div id="stack-manage" class="stack-manage" hidden>
          <div id="stack-manage-list"></div>
          <div class="stack-manage__create">
            <input type="text" id="stack-manage-input" class="input" placeholder="New stack name...">
            <button type="button" id="stack-manage-create-btn" class="btn btn--primary">Create</button>
          </div>
        </div>
```

**Step 4: Add management panel CSS**

In `src/styles/main.css`:

```css
/* Stack management panel */
.stack-manage {
  margin-top: 0.75rem;
  padding: 1rem;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.stack-manage__item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--border);
}

.stack-manage__name {
  flex: 1;
  font-size: 0.875rem;
}

.stack-manage__count {
  color: var(--text-muted);
  font-size: 0.75rem;
}

.stack-manage__rename-btn,
.stack-manage__delete-btn,
.stack-manage__rename-confirm {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 0.75rem;
  padding: 0.25rem 0.5rem;
}

.stack-manage__rename-btn:hover,
.stack-manage__rename-confirm:hover {
  color: var(--text);
}

.stack-manage__delete-btn:hover {
  color: var(--danger);
}

.stack-manage__rename-input {
  flex: 1;
  padding: 0.25rem 0.5rem;
  font-size: 0.875rem;
}

.stack-manage__create {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border);
}

.stack-manage__create .input {
  flex: 1;
  padding: 0.5rem;
  font-size: 0.875rem;
}

.stack-manage__create .btn {
  padding: 0.5rem 1rem;
  font-size: 0.875rem;
}
```

**Step 5: Add management panel rendering and handlers in app.ts**

```typescript
  private async renderStackManagePanel(): Promise<void> {
    const stacks = await this.stackRepository.listStacks()
    const list = document.getElementById('stack-manage-list')!
    list.innerHTML = stacks.map(s => `
      <div class="stack-manage__item" data-manage-stack-id="${s.id}">
        <span class="stack-manage__name">${this.escapeHtml(s.name)}</span>
        <span class="stack-manage__count">${s.item_count} items</span>
        <button class="stack-manage__rename-btn">rename</button>
        <button class="stack-manage__delete-btn">delete</button>
      </div>
    `).join('')
  }

  private setupStackManagePanel(): void {
    const panel = document.getElementById('stack-manage')!
    const manageBtn = document.getElementById('manage-stacks-btn')!

    // Toggle panel visibility
    manageBtn.addEventListener('click', () => {
      const isHidden = panel.hidden
      panel.hidden = !isHidden
      if (!panel.hidden) {
        this.renderStackManagePanel()
      }
    })

    // Create stack
    document.getElementById('stack-manage-create-btn')?.addEventListener('click', async () => {
      const input = document.getElementById('stack-manage-input') as HTMLInputElement
      const name = input.value.trim()
      if (!name) return
      await this.stackRepository.createStack(name)
      input.value = ''
      await this.renderStackBar()
      await this.renderStackManagePanel()
    })

    // Rename and delete via delegation
    document.getElementById('stack-manage-list')?.addEventListener('click', async (e) => {
      const target = e.target as HTMLElement
      const item = target.closest('[data-manage-stack-id]') as HTMLElement
      if (!item) return
      const stackId = Number(item.dataset.manageStackId)

      // Rename
      if (target.classList.contains('stack-manage__rename-btn')) {
        const nameEl = item.querySelector('.stack-manage__name')!
        const currentName = nameEl.textContent!.trim()
        item.innerHTML = `
          <input type="text" class="stack-manage__rename-input input" value="${this.escapeHtml(currentName)}">
          <button class="stack-manage__rename-confirm">save</button>
        `
        const renameInput = item.querySelector('.stack-manage__rename-input') as HTMLInputElement
        renameInput.focus()
        renameInput.select()
      }

      // Confirm rename
      if (target.classList.contains('stack-manage__rename-confirm')) {
        const renameInput = item.querySelector('.stack-manage__rename-input') as HTMLInputElement
        const newName = renameInput.value.trim()
        if (newName) {
          await this.stackRepository.renameStack(stackId, newName)
          await this.renderStackBar()
          await this.renderStackManagePanel()
        }
      }

      // Delete
      if (target.classList.contains('stack-manage__delete-btn')) {
        const stack = this.stacks.find(s => s.id === stackId)
        if (confirm(`Delete "${stack?.name}"? Links won't be deleted, just untagged.`)) {
          await this.stackRepository.deleteStack(stackId)
          if (this.currentStack === stackId) {
            this.currentStack = null
          }
          await this.renderStackBar()
          await this.renderStackManagePanel()
          await this.renderMusicList()
        }
      }
    })
  }
```

Call `this.setupStackManagePanel()` in `initializeUI()`.

**Step 6: Run the e2e test**

Run: `npx playwright test playwright/stacks.spec.ts`
Expected: All stacks tests pass

**Step 7: Run all e2e tests**

Run: `npx playwright test`
Expected: All tests pass

**Step 8: Commit**

```bash
git add index.html src/app.ts src/styles/main.css playwright/stacks.spec.ts
git commit -m "feat: add stack management panel with rename and delete"
```

---

### Task 9: Final verification and cleanup

**Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: No errors

**Step 2: Run all e2e tests**

Run: `npx playwright test`
Expected: All tests pass

**Step 3: Manual smoke test**

Run: `npm run dev`
Verify in browser:
- Add a link, create a stack from the card dropdown
- Switch between All and the new stack tab
- Use status filters within a stack
- Create a stack from add form
- Open manage panel, rename and delete a stack
- Verify deleting a stack doesn't delete the music items

**Step 4: Commit any remaining changes**

```bash
git add -A
git commit -m "feat: stacks feature complete"
```

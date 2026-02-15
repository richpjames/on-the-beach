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

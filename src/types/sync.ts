export type SyncEntity = 'music_item' | 'music_link' | 'artist'
export type SyncAction = 'upsert' | 'delete'
export type SyncConflictReason =
  | 'version_conflict'
  | 'validation_failed'
  | 'not_found'
  | 'forbidden'

export interface SyncPayload {
  id: string
  deletedAt?: string | null
  [key: string]: unknown
}

export interface SyncPushOperation {
  opId: string
  entity: SyncEntity
  action: SyncAction
  payload: SyncPayload
  clientUpdatedAt: string
}

export interface SyncPushRequest {
  deviceId: string
  ops: SyncPushOperation[]
}

export interface SyncConflict {
  opId: string
  entity: SyncEntity
  entityId: string
  reason: SyncConflictReason
  serverVersion: number
  serverRecord?: Record<string, unknown>
}

export interface SyncPushResponse {
  appliedOpIds: string[]
  conflicts: SyncConflict[]
  serverVersion: number
}

export interface SyncChange {
  version: number
  entity: SyncEntity
  entityId: string
  action: SyncAction
  payload: Record<string, unknown>
  updatedAt: string
}

export interface SyncPullResponse {
  changes: SyncChange[]
  nextVersion: number
  hasMore: boolean
}

export interface QueueSyncOperationInput {
  opId?: string
  entity: SyncEntity
  action: SyncAction
  payload: SyncPayload
  clientUpdatedAt?: string
}

export interface SyncRunResult {
  status: 'ok' | 'unauthenticated'
  pushed: number
  pulled: number
  conflicts: number
  cursor: number
}

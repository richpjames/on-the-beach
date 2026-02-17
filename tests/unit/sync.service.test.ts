import { describe, expect, it, vi } from 'vitest'
import { AuthService } from '../../src/services/auth'
import { SyncService } from '../../src/services/sync'
import { FakeDriver } from './helpers/fake-driver'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  })
}

interface FetchRecord {
  url: string
  method: string
  body: unknown
}

function createFetchRecorder(
  handler: (record: FetchRecord) => Promise<Response> | Response
): { fetchImpl: typeof fetch; calls: FetchRecord[] } {
  const calls: FetchRecord[] = []

  const fetchImpl: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null

    const record: FetchRecord = {
      url,
      method,
      body,
    }

    calls.push(record)
    return handler(record)
  }

  return { fetchImpl, calls }
}

function createAuthedService(options: {
  fetchImpl: typeof fetch
  syncConfig?: Partial<ConstructorParameters<typeof SyncService>[2]>
}): { driver: FakeDriver; auth: AuthService; sync: SyncService } {
  const driver = new FakeDriver()
  const auth = new AuthService({
    baseUrl: 'https://api.test',
    fetchImpl: options.fetchImpl,
  })

  auth.setSession({
    userId: 'u1',
    accessToken: 'access-token',
    expiresAt: Date.now() + 60_000,
  })

  const sync = new SyncService(driver, auth, {
    baseUrl: 'https://api.test',
    deviceId: 'device-1',
    ...options.syncConfig,
  })

  return { driver, auth, sync }
}

function musicItemChange(id: string, version: number, title: string) {
  return {
    version,
    entity: 'music_item' as const,
    entityId: id,
    action: 'upsert' as const,
    payload: {
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
      created_at: '2026-02-16T00:00:00.000Z',
      updated_at: '2026-02-16T00:00:00.000Z',
      listened_at: null,
      is_physical: 0,
      physical_format: null,
    },
    updatedAt: '2026-02-16T00:00:00.000Z',
  }
}

describe('SyncService (unit)', () => {
  it('paginates pull and applies changes across pages', async () => {
    const { fetchImpl, calls } = createFetchRecorder(async (record) => {
      if (record.url.startsWith('https://api.test/v1/sync/push')) {
        return jsonResponse({ appliedOpIds: [], conflicts: [], serverVersion: 0 })
      }

      const url = new URL(record.url)
      const since = url.searchParams.get('since')

      if (since === '0') {
        return jsonResponse({
          changes: [musicItemChange('1', 1, 'First')],
          nextVersion: 1,
          hasMore: true,
        })
      }

      return jsonResponse({
        changes: [musicItemChange('2', 2, 'Second')],
        nextVersion: 2,
        hasMore: false,
      })
    })

    const { driver, sync } = createAuthedService({ fetchImpl })
    const result = await sync.runOnce()

    expect(result.pulled).toBe(2)
    expect(result.cursor).toBe(2)
    expect(driver.hasMusicItem(1)).toBe(true)
    expect(driver.hasMusicItem(2)).toBe(true)

    const pullCalls = calls.filter((call) => call.url.startsWith('https://api.test/v1/sync/pull'))
    expect(pullCalls.length).toBe(2)
    expect(new URL(pullCalls[0].url).searchParams.get('since')).toBe('0')
    expect(new URL(pullCalls[1].url).searchParams.get('since')).toBe('1')
  })

  it('respects maxPullPages and resumes from cursor on next run', async () => {
    const seenSince: string[] = []
    const { fetchImpl } = createFetchRecorder(async (record) => {
      if (record.url.startsWith('https://api.test/v1/sync/push')) {
        return jsonResponse({ appliedOpIds: [], conflicts: [], serverVersion: 0 })
      }

      const url = new URL(record.url)
      const since = url.searchParams.get('since') ?? 'missing'
      seenSince.push(since)

      if (since === '0') {
        return jsonResponse({
          changes: [musicItemChange('11', 1, 'Page One')],
          nextVersion: 1,
          hasMore: true,
        })
      }

      return jsonResponse({
        changes: [musicItemChange('12', 2, 'Page Two')],
        nextVersion: 2,
        hasMore: false,
      })
    })

    const { sync, driver } = createAuthedService({
      fetchImpl,
      syncConfig: {
        maxPullPages: 1,
      },
    })

    await sync.runOnce()
    expect(seenSince).toEqual(['0'])
    expect(driver.hasMusicItem(11)).toBe(true)
    expect(driver.hasMusicItem(12)).toBe(false)

    await sync.runOnce()
    expect(seenSince).toEqual(['0', '1'])
    expect(driver.hasMusicItem(12)).toBe(true)
  })

  it('uses pushBatchSize to drain outbox across runs', async () => {
    const pushedBatchSizes: number[] = []

    const { fetchImpl } = createFetchRecorder(async (record) => {
      if (record.url.startsWith('https://api.test/v1/sync/push')) {
        const body = record.body as { ops: Array<{ opId: string }> }
        pushedBatchSizes.push(body.ops.length)
        return jsonResponse({
          appliedOpIds: body.ops.map((op) => op.opId),
          conflicts: [],
          serverVersion: 1,
        })
      }

      return jsonResponse({ changes: [], nextVersion: 0, hasMore: false })
    })

    const { sync, driver } = createAuthedService({
      fetchImpl,
      syncConfig: {
        pushBatchSize: 1,
      },
    })

    await sync.queueOperation({
      opId: 'op-1',
      entity: 'music_item',
      action: 'upsert',
      payload: { id: '1', title: 'a' },
    })

    await sync.queueOperation({
      opId: 'op-2',
      entity: 'music_item',
      action: 'upsert',
      payload: { id: '2', title: 'b' },
    })

    await sync.runOnce()
    expect(pushedBatchSizes).toEqual([1])
    expect(driver.getOutboxOpIds()).toEqual(['op-2'])

    await sync.runOnce()
    expect(pushedBatchSizes).toEqual([1, 1])
    expect(driver.getOutboxOpIds()).toEqual([])
  })

  it('reconciles tombstone conflicts using serverRecord id fallback', async () => {
    const { fetchImpl } = createFetchRecorder(async (record) => {
      if (record.url.startsWith('https://api.test/v1/sync/push')) {
        const body = record.body as { ops: Array<{ opId: string; entity: string; payload?: { id?: string } }> }
        const musicItemOp = body.ops.find((op) => op.entity === 'music_item')

        return jsonResponse({
          appliedOpIds: body.ops.filter((op) => op.entity !== 'music_item').map((op) => op.opId),
          conflicts: musicItemOp
            ? [
                {
                  opId: musicItemOp.opId,
                  entity: 'music_item',
                  entityId: 'not-an-int',
                  reason: 'version_conflict',
                  serverVersion: 10,
                  serverRecord: {
                    id: musicItemOp.payload?.id,
                    deleted_at: '2026-02-16T00:02:00.000Z',
                  },
                },
              ]
            : [],
          serverVersion: 10,
        })
      }

      return jsonResponse({ changes: [], nextVersion: 0, hasMore: false })
    })

    const { sync, driver } = createAuthedService({ fetchImpl })
    driver.seedMusicItem(10, 'To Be Deleted')

    await sync.queueOperation({
      opId: 'op-delete',
      entity: 'music_item',
      action: 'upsert',
      payload: { id: '10', title: 'local title' },
    })

    await sync.runOnce()

    expect(driver.hasMusicItem(10)).toBe(false)
    expect(driver.getOutboxOpIds()).not.toContain('op-delete')
  })

  it('handles malformed serverRecord conflicts gracefully and suppresses retries', async () => {
    const pushSpy = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { fetchImpl } = createFetchRecorder(async (record) => {
      if (record.url.startsWith('https://api.test/v1/sync/push')) {
        pushSpy()
        const body = record.body as { ops: Array<{ opId: string; entity: string }> }
        const musicItemOp = body.ops.find((op) => op.entity === 'music_item')

        return jsonResponse({
          appliedOpIds: body.ops.filter((op) => op.entity !== 'music_item').map((op) => op.opId),
          conflicts: musicItemOp
            ? [
                {
                  opId: musicItemOp.opId,
                  entity: 'music_item',
                  entityId: 'not-an-int',
                  reason: 'validation_failed',
                  serverVersion: 11,
                  serverRecord: {
                    deleted_at: '2026-02-16T00:03:00.000Z',
                  },
                },
              ]
            : [],
          serverVersion: 11,
        })
      }

      return jsonResponse({ changes: [], nextVersion: 0, hasMore: false })
    })

    const { sync, driver } = createAuthedService({ fetchImpl })
    driver.seedMusicItem(20, 'Keep Me')

    await sync.queueOperation({
      opId: 'op-malformed',
      entity: 'music_item',
      action: 'upsert',
      payload: { id: '20', title: 'local title' },
    })

    await sync.runOnce()

    const row = driver.getOutboxRow('op-malformed')
    expect(row).toEqual({ attempts: 1, last_error: 'validation_failed' })
    expect(driver.hasMusicItem(20)).toBe(true)
    expect(warnSpy).toHaveBeenCalled()

    await sync.runOnce()
    expect(pushSpy).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })

  it('honors custom push and pull paths', async () => {
    const { fetchImpl, calls } = createFetchRecorder(async (record) => {
      if (record.url.startsWith('https://api.test/v2/custom/push')) {
        const body = record.body as { ops: Array<{ opId: string }> }
        return jsonResponse({
          appliedOpIds: body.ops.map((op) => op.opId),
          conflicts: [],
          serverVersion: 1,
        })
      }

      if (record.url.startsWith('https://api.test/v2/custom/pull')) {
        return jsonResponse({ changes: [], nextVersion: 0, hasMore: false })
      }

      return jsonResponse({ error: 'unexpected path' }, 404)
    })

    const { sync } = createAuthedService({
      fetchImpl,
      syncConfig: {
        pushPath: '/v2/custom/push',
        pullPath: '/v2/custom/pull',
      },
    })

    await sync.queueOperation({
      opId: 'custom-op',
      entity: 'music_item',
      action: 'upsert',
      payload: { id: '99', title: 'custom' },
    })

    await sync.runOnce()

    const urls = calls.map((call) => call.url)
    expect(urls.some((value) => value.includes('/v2/custom/push'))).toBe(true)
    expect(urls.some((value) => value.includes('/v2/custom/pull'))).toBe(true)
    expect(urls.some((value) => value.includes('/v1/sync/push'))).toBe(false)
    expect(urls.some((value) => value.includes('/v1/sync/pull'))).toBe(false)
  })

  it('returns unauthenticated when refresh fails and does not call sync endpoints', async () => {
    const { fetchImpl, calls } = createFetchRecorder(async (record) => {
      if (record.url.startsWith('https://api.test/v1/auth/refresh')) {
        return jsonResponse({ error: 'unauthorized' }, 401)
      }

      return jsonResponse({ error: 'should not be called' }, 500)
    })

    const driver = new FakeDriver()
    const auth = new AuthService({
      baseUrl: 'https://api.test',
      fetchImpl,
    })

    const sync = new SyncService(driver, auth, {
      baseUrl: 'https://api.test',
      deviceId: 'device-unauth',
    })

    const result = await sync.runOnce()

    expect(result.status).toBe('unauthenticated')
    expect(result.pushed).toBe(0)
    expect(result.pulled).toBe(0)

    const syncCalls = calls.filter((call) => call.url.includes('/v1/sync/'))
    expect(syncCalls).toHaveLength(0)
  })
})

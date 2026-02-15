import { expect, test } from '@playwright/test'

test('startup sync pulls remote changes into the visible library', async ({ page }) => {
  let refreshCalled = false
  let pullCalled = false

  await page.addInitScript(() => {
    ;(window as Window & { __ON_THE_BEACH_SYNC_CONFIG__?: unknown }).__ON_THE_BEACH_SYNC_CONFIG__ = {
      baseUrl: 'http://127.0.0.1:4175',
      deviceId: 'device-e2e-1',
      enabled: true,
    }
  })

  await page.route('**/v1/auth/refresh', async (route) => {
    refreshCalled = true
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        userId: 'user-1',
        accessToken: 'token-refreshed',
        expiresIn: 1200,
      }),
    })
  })

  await page.route('**/v1/sync/pull**', async (route) => {
    pullCalled = true
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        changes: [
          {
            version: 1,
            entity: 'music_item',
            entityId: '101',
            action: 'upsert',
            payload: {
              id: '101',
              title: 'Remote Album',
              normalized_title: 'remote album',
              item_type: 'album',
              artist_id: null,
              listen_status: 'to-listen',
              purchase_intent: 'no',
              price_cents: null,
              currency: 'USD',
              notes: null,
              rating: null,
              created_at: '2026-02-15T00:00:00.000Z',
              updated_at: '2026-02-15T00:00:00.000Z',
              listened_at: null,
              is_physical: 0,
              physical_format: null,
            },
            updatedAt: '2026-02-15T00:00:00.000Z',
          },
          {
            version: 2,
            entity: 'music_link',
            entityId: '301',
            action: 'upsert',
            payload: {
              id: '301',
              music_item_id: '101',
              source_id: null,
              url: 'https://example.com/remote-album',
              is_primary: 1,
              created_at: '2026-02-15T00:00:00.000Z',
            },
            updatedAt: '2026-02-15T00:00:00.000Z',
          },
        ],
        nextVersion: 2,
        hasMore: false,
      }),
    })
  })

  await page.goto('/')

  await expect.poll(() => refreshCalled, { timeout: 10_000 }).toBe(true)
  await expect.poll(() => pullCalled, { timeout: 10_000 }).toBe(true)
  await expect(page.locator('.music-card', { hasText: 'Remote Album' })).toBeVisible({ timeout: 10_000 })
})

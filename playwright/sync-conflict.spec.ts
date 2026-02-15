import { expect, test } from '@playwright/test'

test('conflicted outbox operations are not retried endlessly', async ({ page }) => {
  let pushCount = 0
  const pushedOpIds: string[] = []

  await page.addInitScript(() => {
    ;(window as Window & { __ON_THE_BEACH_SYNC_CONFIG__?: unknown }).__ON_THE_BEACH_SYNC_CONFIG__ = {
      baseUrl: 'http://127.0.0.1:4175',
      deviceId: 'device-e2e-3',
      enabled: true,
      intervalMs: 200,
    }

    localStorage.setItem(
      'otb.auth.session',
      JSON.stringify({
        userId: 'user-3',
        accessToken: 'token-existing',
        expiresAt: Date.now() + 60 * 60 * 1000,
      })
    )
  })

  await page.route('**/v1/sync/pull**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ changes: [], nextVersion: 0, hasMore: false }),
    })
  })

  await page.route('**/v1/sync/push', async (route) => {
    pushCount += 1

    const bodyText = route.request().postData() || '{}'
    const body = JSON.parse(bodyText) as {
      ops?: Array<{ opId: string; entity: string }>
    }

    const first = body.ops?.[0]
    if (first?.opId) {
      pushedOpIds.push(first.opId)
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        appliedOpIds: [],
        conflicts: first
          ? [
              {
                opId: first.opId,
                entity: first.entity,
                entityId: '1',
                reason: 'version_conflict',
                serverVersion: 10,
              },
            ]
          : [],
        serverVersion: 10,
      }),
    })
  })

  await page.goto('/')

  await page
    .getByPlaceholder('Paste a music link...')
    .fill('https://seekersinternational.bandcamp.com/album/thewherebetweenyou-me-reissue')
  await page.getByRole('button', { name: 'Add' }).click()

  await expect.poll(() => pushCount, { timeout: 10_000 }).toBeGreaterThan(0)
  await page.waitForTimeout(1500)

  const uniqueOpIds = new Set(pushedOpIds)
  expect(uniqueOpIds.size).toBeGreaterThan(0)
  expect(pushedOpIds.length).toBe(uniqueOpIds.size)
  expect(pushCount).toBeLessThanOrEqual(uniqueOpIds.size)
})

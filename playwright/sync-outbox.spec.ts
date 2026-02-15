import { expect, test } from '@playwright/test'

test('adding a link enqueues a sync op that gets pushed', async ({ page }) => {
  const pushedBodies: Array<{
    deviceId?: string
    ops?: Array<{ entity?: string; action?: string; payload?: { url?: string } }>
  }> = []

  await page.addInitScript(() => {
    ;(window as Window & { __ON_THE_BEACH_SYNC_CONFIG__?: unknown }).__ON_THE_BEACH_SYNC_CONFIG__ = {
      baseUrl: 'http://127.0.0.1:4175',
      deviceId: 'device-e2e-2',
      enabled: true,
      intervalMs: 200,
    }

    localStorage.setItem(
      'otb.auth.session',
      JSON.stringify({
        userId: 'user-2',
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
    const bodyText = route.request().postData() || '{}'
    const body = JSON.parse(bodyText) as {
      deviceId?: string
      ops?: Array<{ opId: string; entity?: string; action?: string; payload?: { url?: string } }>
    }
    pushedBodies.push(body)

    const appliedOpIds = (body.ops || []).map((op) => op.opId)

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        appliedOpIds,
        conflicts: [],
        serverVersion: 1,
      }),
    })
  })

  await page.goto('/')

  await page.getByPlaceholder('Paste a music link...').fill('https://seekersinternational.bandcamp.com/album/thewherebetweenyou-me-reissue')
  await page.getByRole('button', { name: 'Add' }).click()

  await expect.poll(() => pushedBodies.flatMap((body) => body.ops || []).length, { timeout: 10_000 }).toBeGreaterThan(0)

  await expect
    .poll(
      () => {
        const allOps = pushedBodies.flatMap((body) => body.ops || [])
        return allOps.some((op) => op.entity === 'music_item' && op.action === 'upsert')
      },
      { timeout: 10_000 }
    )
    .toBe(true)

  await expect
    .poll(
      () => {
        const allOps = pushedBodies.flatMap((body) => body.ops || [])
        return allOps.some(
          (op) =>
            op.entity === 'music_link' &&
            op.action === 'upsert' &&
            op.payload?.url ===
              'https://seekersinternational.bandcamp.com/album/thewherebetweenyou-me-reissue'
        )
      },
      { timeout: 10_000 }
    )
    .toBe(true)
})

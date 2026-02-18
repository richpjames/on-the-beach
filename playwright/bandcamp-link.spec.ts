import { expect, test } from '@playwright/test'

test.beforeEach(async ({ request }) => {
  await request.post('/api/__test__/reset')
})

test('adding the Seekers International Bandcamp URL creates a working Bandcamp link', async ({
  page,
}) => {
  const bandcampUrl =
    'https://seekersinternational.bandcamp.com/album/thewherebetweenyou-me-reissue'

  await page.goto('/')
  await page.getByPlaceholder('Paste a music link...').fill(bandcampUrl)
  await page.getByRole('button', { name: 'Add' }).click()

  const card = page
    .locator('.music-card', {
      has: page.locator(`a[href="${bandcampUrl}"]`),
    })
    .first()

  await expect(card).toBeVisible({ timeout: 10_000 })

  const sourceBadgeLink = card.locator(`.badge--source[href="${bandcampUrl}"]`)
  await expect(sourceBadgeLink).toHaveText('bandcamp')

  const popupPromise = page.waitForEvent('popup')
  await sourceBadgeLink.click()
  const popup = await popupPromise
  await expect(popup).toHaveURL(bandcampUrl)
  await popup.close()
})

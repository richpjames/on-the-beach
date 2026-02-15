import { expect, test } from '@playwright/test'

test('adding a link shows the new item', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByPlaceholder('Paste a music link...')).toBeVisible()
  page.on('dialog', async (dialog) => {
    await dialog.accept()
  })

  const bandcampUrl = 'https://seekersinternational.bandcamp.com/album/thewherebetweenyou-me-reissue'
  const countBefore = await page.locator('.music-card').count()

  for (let i = 0; i < 3; i++) {
    await page.getByPlaceholder('Paste a music link...').fill(bandcampUrl)
    await page.getByRole('button', { name: 'Add' }).click()
    await page.waitForTimeout(800)

    const countNow = await page.locator('.music-card').count()
    if (countNow > countBefore) break
  }

  await expect
    .poll(async () => page.locator('.music-card').count(), { timeout: 10_000 })
    .toBeGreaterThan(countBefore)
})

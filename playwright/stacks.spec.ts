import { expect, test } from '@playwright/test'

test.describe('Stacks', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByPlaceholder('Paste a music link...')).toBeVisible()
  })

  test('can create a stack and assign a link to it', async ({ page }) => {
    // Add a link
    await page.getByPlaceholder('Paste a music link...').fill(
      'https://seekersinternational.bandcamp.com/album/test-stacks'
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

    // Close dropdown
    await page.keyboard.press('Escape')

    // Click the Salsa tab
    await page.locator('.stack-tab', { hasText: 'Salsa' }).click()

    // Card should still be visible (it's in the Salsa stack)
    await expect(page.locator('.music-card').first()).toBeVisible()
  })

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
})

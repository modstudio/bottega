import { expect, test } from '@playwright/test'

test('browser fixture', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle('fixture')
})

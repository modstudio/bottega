import { businessTest } from './test-substance-derived-browser-helper.fixtures'

businessTest('derived browser fixture', async ({ page }) => {
  await page.goto('/')
})

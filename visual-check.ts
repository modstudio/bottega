import { chromium } from '/Users/shmuel/.bun/install/cache/playwright-core@1.56.1@@@1/index.mjs'

const root = '/Users/shmuel/.local/state/bottega/orchestrator/runs/11055/scratch'
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })

await page.goto('http://127.0.0.1:21007/docs')
await page.locator('.doc-title').waitFor()
await page.screenshot({ path: `${root}/header-strip.png` })

const projectSelect = page.getByRole('combobox')
await projectSelect.click()
console.log(await page.getByRole('option').allTextContents())
await page.getByRole('option', { name: 'bottega', exact: true }).click()
await page.waitForTimeout(500)

const articleTitles = (await page.locator('nav button[title]').allTextContents()).filter(
  (title) => title !== 'Search docs',
)
console.log(articleTitles.slice(0, 100))
const headingArticle = articleTitles.find((title) => title.includes('00-principles')) ?? articleTitles[0]
if (!headingArticle) throw new Error('No Bottega article was available')
await page.getByTitle(headingArticle, { exact: true }).click()
await page.waitForTimeout(500)
await page.getByText('On this page', { exact: true }).waitFor()
await page.screenshot({ path: `${root}/contents-tab.png` })

await page.getByRole('tab', { name: 'Details' }).click()
await page.getByRole('button', { name: /History/ }).click()
await page.locator('[aria-expanded="true"]').waitFor()
await page.screenshot({ path: `${root}/details-history-expanded.png` })

const superseded = page.locator('nav [data-doc-status="superseded"]').first()
await superseded.waitFor()
await superseded.locator('xpath=ancestor::button[1]').click()
await page.getByText(/Replaced by/).waitFor()
await page.screenshot({ path: `${root}/superseded-strip.png` })

await browser.close()

import { navForMode } from '@bottega/hub-data/hub-mode'
import type { Page } from 'playwright'

export const SETTLE_TIMEOUT_MS = 10_000

export function routesForMode(mode: 'local' | 'hosted'): string[] {
  const routes = navForMode(mode).flatMap((section) =>
    section.entries.flatMap((entry) =>
      'items' in entry ? entry.items.map((item) => item.to) : entry.to,
    ),
  )
  return ['/', ...new Set(routes)]
}

export function collectRenderEvidence(page: Page, origin: string): string[] {
  const evidence: string[] = []
  page.on('pageerror', (error) => evidence.push(`uncaught page error: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const location = message.location()
    const source = location.url ? ` (${location.url}:${location.lineNumber})` : ''
    evidence.push(`console error: ${message.text()}${source}`)
  })
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.origin === origin && response.status() >= 500) {
      evidence.push(`same-origin ${response.status()} response: ${url.pathname}${url.search}`)
    }
  })
  return evidence
}

function rootRendered(): boolean {
  const root = document.querySelector('#root')
  return Boolean(root?.childElementCount || root?.textContent?.trim())
}

export async function waitForRootRendered(page: Page, route: string, phase: string): Promise<void> {
  try {
    await page.locator('#root').waitFor({ state: 'attached', timeout: 5_000 })
    await page.waitForFunction(rootRendered)
  } catch (error) {
    throw new Error(`${route} ${phase}: application root rendered nothing (${String(error)})`)
  }
}

export async function rootStillRendered(page: Page): Promise<boolean> {
  return page.evaluate(rootRendered)
}

export async function assertRendered(page: Page, route: string, phase: string): Promise<void> {
  await waitForRootRendered(page, route, phase)
  await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => {})
  if (!(await rootStillRendered(page))) {
    throw new Error(`${route} ${phase}: application root emptied after rendering`)
  }
}

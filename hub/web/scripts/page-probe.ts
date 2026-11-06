import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type Browser, type BrowserContext, chromium, type Page, type Request } from 'playwright'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { readEnvValues } from '../../../shared/env-values.ts'
import { resolveRecordApiUrl } from '../../../shared/record-api-url.ts'
import { readRecordSessionTokenAsync } from '../../../shared/record-session.ts'
import { concernStateDirectory } from '../../../shared/state-directory.ts'
import {
  command as dashboardCommand,
  distribution,
  executable,
  freePort,
  pipedOutput,
  repoRoot,
  stopServer,
  waitForServer,
} from './dashboard-server.ts'
import {
  collectRenderEvidence,
  rootStillRendered,
  routesForMode,
  SETTLE_TIMEOUT_MS,
  waitForRootRendered,
} from './page-check.ts'
import {
  firstSampleLink,
  PARAMETERIZED_ROUTES,
  slowestFirst,
  UNTIMED_ROUTES,
} from './page-probe-decision.ts'

type Mode = 'local' | 'hosted'
type Phase = 'cold' | 'reload'
type SlowRequest = { path: string; durationMs: number }
type ProbeRow = {
  mode: Mode
  route: string
  phase: Phase | 'sample'
  status: number | 'no sample' | null
  renderMs: number | null
  settleMs: number | null
  slowestRequest: SlowRequest | null
  evidence: string[]
  rendered: boolean | null
  timed: boolean
}

function requestedModes(): { label: 'local' | 'hosted' | 'both'; modes: Mode[] } {
  const args = process.argv.slice(2)
  const index = args.indexOf('--mode')
  const value = index >= 0 ? args[index + 1] : undefined
  if (value === 'local' || value === 'hosted') return { label: value, modes: [value] }
  if (value === 'both') return { label: value, modes: ['local', 'hosted'] }
  throw new Error('usage: bun run probe -- --mode local|hosted|both')
}

function requestPath(request: Request): string {
  const url = new URL(request.url())
  return `${url.pathname}${url.search}`
}

function requestDuration(request: Request): number | null {
  // Playwright reports responseEnd in milliseconds relative to startTime.
  const timing = request.timing()
  if (timing.startTime < 0 || timing.responseEnd < 0) return null
  return timing.responseEnd
}

function isMeasuredRequest(request: Request, origin: string): boolean {
  const url = new URL(request.url())
  return (
    url.origin === origin || request.resourceType() === 'fetch' || request.resourceType() === 'xhr'
  )
}

async function measurePhase(
  page: Page,
  origin: string,
  mode: Mode,
  route: string,
  phase: Phase,
  timed: boolean,
  navigate: () => ReturnType<Page['goto']>,
): Promise<ProbeRow> {
  const evidence = collectRenderEvidence(page, origin)
  let slowestRequest: SlowRequest | null = null
  page.on('requestfailed', (request) => {
    evidence.push(
      `failed request: ${requestPath(request)} (${request.failure()?.errorText ?? 'unknown'})`,
    )
  })
  page.on('response', (response) => {
    if (!isMeasuredRequest(response.request(), origin) || response.status() < 400) return
    evidence.push(`failed ${response.status()} response: ${requestPath(response.request())}`)
  })
  page.on('requestfinished', (request) => {
    if (!isMeasuredRequest(request, origin)) return
    const durationMs = requestDuration(request)
    if (durationMs === null || (slowestRequest && slowestRequest.durationMs >= durationMs)) return
    slowestRequest = { path: requestPath(request), durationMs }
  })

  const started = performance.now()
  let status: number | null = null
  let renderMs: number | null = null
  let settleMs: number | null = null
  let rendered = false
  try {
    const response = await navigate()
    status = response?.status() ?? null
    if (status !== 200) evidence.push(`document returned ${status ?? 'no response'}`)
    await waitForRootRendered(page, route, phase)
    renderMs = performance.now() - started
    const elapsed = performance.now() - started
    const remaining = Math.max(1, SETTLE_TIMEOUT_MS - elapsed)
    await page.waitForLoadState('networkidle', { timeout: remaining }).catch(() => {})
    settleMs = Math.min(performance.now() - started, SETTLE_TIMEOUT_MS)
    rendered = await rootStillRendered(page)
    if (!rendered) evidence.push('application root emptied after rendering')
  } catch (error) {
    evidence.push(error instanceof Error ? error.message : String(error))
    settleMs = Math.min(performance.now() - started, SETTLE_TIMEOUT_MS)
  }
  return {
    mode,
    route,
    phase,
    status,
    renderMs: timed ? renderMs : null,
    settleMs: timed ? settleMs : null,
    slowestRequest: timed ? slowestRequest : null,
    evidence: [...new Set(evidence)],
    rendered,
    timed,
  }
}

/**
 * List rows and cards navigate on click rather than through anchors, and some lists open their
 * first record by themselves. Keep the current URL when it already has the route's shape;
 * otherwise follow the first record element and keep where it lands.
 */
async function clickedSample(page: Page, template: string, origin: string): Promise<string | null> {
  const already = firstSampleLink(template, [page.url()], origin)
  if (already) return already
  const row = page.locator('[data-record-key]').first()
  if ((await row.count()) === 0) return null
  const before = page.url()
  await row.click({ timeout: 2_000 }).catch(() => {})
  await page.waitForURL((url) => url.href !== before, { timeout: 3_000 }).catch(() => {})
  return firstSampleLink(template, [page.url()], origin)
}

type Samples = { found: Map<string, string>; failures: Map<string, string> }

async function sampleRoutes(context: BrowserContext, origin: string): Promise<Samples> {
  const samples = new Map<string, string>()
  const failures = new Map<string, string>()
  const page = await context.newPage()
  try {
    for (const definition of PARAMETERIZED_ROUTES) {
      try {
        await page.goto(new URL(definition.parent, origin).href, {
          waitUntil: 'domcontentloaded',
        })
        await waitForRootRendered(page, definition.parent, 'sample discovery')
        // Records arrive after first render, so sample only once the list's queries settle.
        await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => {})
        const hrefs = await page
          .locator('a[href]')
          .evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).href))
        const sample =
          firstSampleLink(definition.template, hrefs, origin) ??
          (await clickedSample(page, definition.template, origin))
        if (sample) samples.set(definition.template, sample)
      } catch (error) {
        failures.set(
          definition.template,
          `sample discovery on ${definition.parent} failed: ${(error as Error).message}`,
        )
      }
    }
  } finally {
    await page.close()
  }
  return { found: samples, failures }
}

async function probeMode(context: BrowserContext, origin: string, mode: Mode): Promise<ProbeRow[]> {
  const samples = await sampleRoutes(context, origin)
  const rows: ProbeRow[] = []
  const measuredRoutes = routesForMode(mode)
  for (const definition of PARAMETERIZED_ROUTES) {
    const sample = samples.found.get(definition.template)
    if (sample) measuredRoutes.push(sample)
    else {
      rows.push({
        mode,
        route: definition.template,
        phase: 'sample',
        status: 'no sample',
        renderMs: null,
        settleMs: null,
        slowestRequest: null,
        evidence: [
          samples.failures.get(definition.template) ?? 'no matching row on the parent list',
        ],
        rendered: null,
        timed: true,
      })
    }
  }

  for (const [route, timed] of [
    ...[...new Set(measuredRoutes)].map((route) => [route, true] as const),
    ...UNTIMED_ROUTES.map((route) => [route, false] as const),
  ]) {
    const page = await context.newPage()
    try {
      rows.push(
        await measurePhase(page, origin, mode, route, 'cold', timed, () =>
          page.goto(new URL(route, origin).href, { waitUntil: 'domcontentloaded' }),
        ),
      )
      rows.push(
        await measurePhase(page, origin, mode, route, 'reload', timed, () =>
          page.reload({ waitUntil: 'domcontentloaded' }),
        ),
      )
    } finally {
      await page.close()
    }
  }
  return rows
}

function failures(rows: readonly ProbeRow[]): ProbeRow[] {
  return rows.filter(
    (row) =>
      row.status !== 'no sample' &&
      (row.status !== 200 || row.rendered !== true || row.evidence.length > 0),
  )
}

function printTable(rows: readonly ProbeRow[]): void {
  console.table(
    slowestFirst(rows).map((row) => ({
      mode: row.mode,
      route: row.route,
      phase: row.phase,
      status: row.status,
      render_ms: row.renderMs === null ? '-' : row.renderMs.toFixed(1),
      settle_ms: row.settleMs === null ? '-' : row.settleMs.toFixed(1),
      slowest: row.slowestRequest
        ? `${row.slowestRequest.path} (${row.slowestRequest.durationMs.toFixed(1)}ms)`
        : '-',
      result:
        row.status === 'no sample'
          ? 'no sample'
          : row.status === 200 && row.rendered && row.evidence.length === 0
            ? 'rendered'
            : row.evidence.join('; ') || 'failed',
    })),
  )
}

const request = requestedModes()
if (!existsSync(distribution)) {
  throw new Error(`page probe requires the built bundle at ${dirname(distribution)}`)
}

let browser: Browser | undefined
let localServer: ReturnType<typeof Bun.spawn> | undefined
let localServerOutput: Promise<[string, string]> | undefined
const rows: ProbeRow[] = []
try {
  browser = await chromium.launch({ headless: true })
  for (const mode of request.modes) {
    if (mode === 'local') {
      const port = await freePort()
      const origin = `http://127.0.0.1:${port}`
      localServer = Bun.spawn([executable, 'dashboard', 'start', '--port', String(port)], {
        cwd: repoRoot,
        env: process.env,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      localServerOutput = Promise.all([
        new Response(pipedOutput(localServer.stdout)).text(),
        new Response(pipedOutput(localServer.stderr)).text(),
      ])
      await waitForServer(origin, localServer.exited)
      const loginUrl = await dashboardCommand(
        ['dashboard', 'login', '--port', String(port)],
        process.env,
      )
      const context = await browser.newContext()
      try {
        const login = await context.newPage()
        await login.goto(loginUrl, { waitUntil: 'domcontentloaded' })
        await login.waitForURL((url) => url.origin === origin && url.pathname === '/')
        await login.close()
        rows.push(...(await probeMode(context, origin, mode)))
      } finally {
        await context.close()
        await stopServer(localServer)
        localServer = undefined
      }
    } else {
      const configured = readEnvValues(['BOTTEGA_HOSTED_URL'], process.env).BOTTEGA_HOSTED_URL
      if (!configured) throw new Error('BOTTEGA_HOSTED_URL is not configured')
      const origin = new URL(configured).origin
      const token = await readRecordSessionTokenAsync()
      if (!token) {
        throw new Error(`record session is absent; run ${PLATFORM_SLUG} record sign-in`)
      }
      const context = await browser.newContext()
      // The bearer goes only to the hosted hub and the record API it calls, never to a third party.
      const bearerOrigins = new Set([origin, new URL(resolveRecordApiUrl(process.env)).origin])
      await context.route(
        (url) => bearerOrigins.has(url.origin),
        (route) =>
          route.continue({
            headers: { ...route.request().headers(), authorization: `Bearer ${token}` },
          }),
      )
      try {
        rows.push(...(await probeMode(context, origin, mode)))
      } finally {
        await context.close()
      }
    }
  }
} finally {
  await browser?.close()
  if (localServer) await stopServer(localServer)
  if (localServerOutput) {
    const [stdout, stderr] = await localServerOutput
    if (stdout.trim()) console.log(stdout.trim())
    if (stderr.trim()) console.error(stderr.trim())
  }
}

printTable(rows)
const generatedAt = new Date().toISOString()
const reportDirectory = concernStateDirectory('hub', process.env)
mkdirSync(reportDirectory, { recursive: true })
const stamp = generatedAt.replace(/[:.]/g, '-')
const reportPath = join(reportDirectory, `page-probe-${request.label}-${stamp}.json`)
writeFileSync(
  reportPath,
  `${JSON.stringify({ generatedAt, mode: request.label, settleTimeoutMs: SETTLE_TIMEOUT_MS, rows }, null, 2)}\n`,
  { mode: 0o600 },
)
console.log(`report: ${reportPath}`)

const failed = failures(rows)
if (failed.length > 0) {
  for (const row of failed) {
    console.error(`${row.mode} ${row.route} ${row.phase}: ${row.evidence.join('; ') || 'failed'}`)
  }
  process.exitCode = 1
}

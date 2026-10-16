import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Browser, chromium, type Page } from 'playwright'
import { STATE_HOME_ENV } from '../../../shared/state-directory.ts'
import { LOCAL_NAV } from '../src/lib/hub-mode.ts'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const executable = join(repoRoot, 'bin', 'bottega')
const distribution = join(repoRoot, 'hub', 'web', 'dist', 'index.html')
const stateRoot = mkdtempSync(join(tmpdir(), 'bottega-dashboard-smoke-'))
const startedAt = performance.now()

function smokeEnvironment(): Record<string, string | undefined> {
  const env = { ...process.env, [STATE_HOME_ENV]: stateRoot }
  delete env.ORCH_DB
  delete env.ORCH_RUNS
  delete env.HUB_DB
  return env
}

async function command(args: string[]): Promise<string> {
  const child = Bun.spawn([executable, ...args], {
    cwd: repoRoot,
    env: smokeEnvironment(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(
      `${executable} ${args.join(' ')} exited ${exitCode}: ${stderr.trim() || stdout.trim()}`,
    )
  }
  return stdout.trim()
}

async function freePort(): Promise<number> {
  const reservation = createServer()
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject)
    reservation.listen(0, '127.0.0.1', resolve)
  })
  const address = reservation.address()
  const port = typeof address === 'object' && address !== null ? address.port : undefined
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  )
  if (port === undefined) throw new Error('could not reserve a dashboard smoke port')
  return port
}

async function waitForServer(origin: string, exited: Promise<number>): Promise<void> {
  let lastFailure = 'no response'
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      await fetch(origin)
      return
    } catch (error) {
      lastFailure = String(error)
    }
    const result = await Promise.race([
      exited.then((exitCode) => ({ exitCode })),
      Bun.sleep(50).then(() => null),
    ])
    if (result)
      throw new Error(`dashboard server exited ${result.exitCode} before accepting requests`)
  }
  throw new Error(`dashboard server did not accept requests: ${lastFailure}`)
}

function localRoutes(): string[] {
  const routes = LOCAL_NAV.flatMap((section) =>
    section.entries.flatMap((entry) =>
      'items' in entry ? entry.items.map((item) => item.to) : entry.to,
    ),
  )
  return ['/', ...new Set(routes)]
}

function collectEvidence(page: Page, origin: string): string[] {
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

async function assertRendered(page: Page, route: string, phase: string): Promise<void> {
  try {
    await page.locator('#root').waitFor({ state: 'attached', timeout: 5_000 })
    await page.waitForFunction(() => {
      const root = document.querySelector('#root')
      return Boolean(root?.childElementCount || root?.textContent?.trim())
    })
    await page.waitForTimeout(100)
  } catch (error) {
    throw new Error(`${route} ${phase}: application root rendered nothing (${String(error)})`)
  }
}

async function stopServer(server: ReturnType<typeof Bun.spawn>): Promise<void> {
  server.kill()
  const stopped = await Promise.race([
    server.exited.then(() => true),
    Bun.sleep(5_000).then(() => false),
  ])
  if (!stopped) {
    server.kill(9)
    await server.exited
  }
}

let browser: Browser | undefined
let server: ReturnType<typeof Bun.spawn> | undefined
let serverOutput: Promise<[string, string]> | undefined
try {
  if (!existsSync(distribution)) {
    throw new Error(`dashboard smoke requires the built bundle at ${dirname(distribution)}`)
  }
  await command(['machine', 'migrate'])

  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  server = Bun.spawn([executable, 'dashboard', 'start', '--port', String(port)], {
    cwd: repoRoot,
    env: smokeEnvironment(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  serverOutput = Promise.all([
    new Response(server.stdout).text(),
    new Response(server.stderr).text(),
  ])
  await waitForServer(origin, server.exited)

  const loginUrl = await command(['dashboard', 'login', '--port', String(port)])
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  let currentRoute = '/login'
  const evidence = collectEvidence(page, origin)
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForURL((url) => url.origin === origin && url.pathname === '/')

  for (const route of localRoutes()) {
    currentRoute = route
    evidence.length = 0
    await page.goto(new URL(route, origin).href, { waitUntil: 'domcontentloaded' })
    await assertRendered(page, currentRoute, 'direct navigation')
    if (evidence.length > 0) {
      throw new Error(`${currentRoute} direct navigation: ${evidence.join('; ')}`)
    }

    evidence.length = 0
    await page.reload({ waitUntil: 'domcontentloaded' })
    await assertRendered(page, currentRoute, 'reload')
    if (evidence.length > 0) throw new Error(`${currentRoute} reload: ${evidence.join('; ')}`)
    console.log(`passed ${currentRoute}`)
  }
  console.log(
    `dashboard smoke passed ${localRoutes().length} routes in ${((performance.now() - startedAt) / 1_000).toFixed(2)}s`,
  )
} finally {
  await browser?.close()
  if (server) await stopServer(server)
  if (serverOutput) {
    const [stdout, stderr] = await serverOutput
    if (stdout.trim()) console.log(stdout.trim())
    if (stderr.trim()) console.error(stderr.trim())
  }
  rmSync(stateRoot, { recursive: true, force: true })
}

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { CONFIG_HOME_ENV } from '../../../shared/config-directory.ts'
import { STATE_HOME_ENV } from '../../../shared/state-directory.ts'
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
import { assertRendered, collectRenderEvidence, routesForMode } from './page-check.ts'

const stateRoot = mkdtempSync(join(tmpdir(), `${PLATFORM_SLUG}-dashboard-smoke-`))
const startedAt = performance.now()

function smokeEnvironment(): Record<string, string | undefined> {
  const env = {
    ...process.env,
    [CONFIG_HOME_ENV]: join(stateRoot, 'config'),
    [STATE_HOME_ENV]: stateRoot,
  }
  delete env.BOTTEGA_ORCHESTRATOR_DB
  delete env.BOTTEGA_RUNS
  delete env.BOTTEGA_HUB_DB
  return env
}

let browser: Browser | undefined
let server: ReturnType<typeof Bun.spawn> | undefined
let serverOutput: Promise<[string, string]> | undefined
try {
  if (!existsSync(distribution)) {
    throw new Error(`dashboard smoke requires the built bundle at ${dirname(distribution)}`)
  }
  await dashboardCommand(['machine', 'migrate'], smokeEnvironment())

  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  server = Bun.spawn([executable, 'dashboard', 'start', '--port', String(port)], {
    cwd: repoRoot,
    env: smokeEnvironment(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  serverOutput = Promise.all([
    new Response(pipedOutput(server.stdout)).text(),
    new Response(pipedOutput(server.stderr)).text(),
  ])
  await waitForServer(origin, server.exited)

  const loginUrl = await dashboardCommand(
    ['dashboard', 'login', '--port', String(port)],
    smokeEnvironment(),
  )
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const evidence = collectRenderEvidence(page, origin)
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForURL((url) => url.origin === origin && url.pathname === '/')

  for (const route of routesForMode('local')) {
    evidence.length = 0
    await page.goto(new URL(route, origin).href, { waitUntil: 'domcontentloaded' })
    await assertRendered(page, route, 'direct navigation')
    if (evidence.length > 0) {
      throw new Error(`${route} direct navigation: ${evidence.join('; ')}`)
    }

    evidence.length = 0
    await page.reload({ waitUntil: 'domcontentloaded' })
    await assertRendered(page, route, 'reload')
    if (evidence.length > 0) throw new Error(`${route} reload: ${evidence.join('; ')}`)
    console.log(`passed ${route}`)
  }
  console.log(
    `dashboard smoke passed ${routesForMode('local').length} routes in ${((performance.now() - startedAt) / 1_000).toFixed(2)}s`,
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

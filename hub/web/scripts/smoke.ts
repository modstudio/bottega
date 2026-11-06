import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Browser, chromium } from 'playwright'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { CONFIG_HOME_ENV } from '../../../shared/config-directory.ts'
import { STATE_HOME_ENV } from '../../../shared/state-directory.ts'
import { assertRendered, collectRenderEvidence, routesForMode } from './page-check.ts'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const executable = join(repoRoot, 'bin', PLATFORM_SLUG)
const distribution = join(repoRoot, 'hub', 'web', 'dist', 'index.html')
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
const pipedOutput = (stream: Bun.Subprocess['stdout']): ReadableStream<Uint8Array> => {
  // The dashboard subprocess configures both output channels as pipes.
  return stream as ReadableStream<Uint8Array>
}
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
    new Response(pipedOutput(server.stdout)).text(),
    new Response(pipedOutput(server.stderr)).text(),
  ])
  await waitForServer(origin, server.exited)

  const loginUrl = await command(['dashboard', 'login', '--port', String(port)])
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

import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { BOTTEGA_ENTRY_PROTOCOL } from '../shared/self-spawn.ts'
import { buildHostBinary } from './build-binary.ts'

const scratch = mkdtempSync(join(tmpdir(), `${PLATFORM_SLUG}-smoke-`))

function smokeEnvironment(stateHome: string): Record<string, string | undefined> {
  const env = { ...process.env, BOTTEGA_STATE_HOME: stateHome }
  delete env.ORCH_DB
  delete env.ORCH_DB_WRITE
  delete env.HUB_DB
  return env
}

async function smoke(
  executable: string,
  args: string[],
  stateHome: string,
  expectedOutput?: string,
  expectedExit = 0,
): Promise<void> {
  const rendered = [executable, ...args].join(' ')
  const child = Bun.spawn([executable, ...args], {
    env: smokeEnvironment(stateHome),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  console.log(`$ ${rendered}`)
  if (stdout.trim()) console.log(stdout.trim())
  if (stderr.trim()) console.error(stderr.trim())
  console.log(`exit ${exitCode}`)
  if (exitCode !== expectedExit) {
    throw new Error(`${rendered} exited ${exitCode}, expected ${expectedExit}`)
  }
  const output = `${stdout}\n${stderr}`
  if (expectedOutput && !output.includes(expectedOutput)) {
    throw new Error(`${rendered} output did not include ${JSON.stringify(expectedOutput)}`)
  }
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
  if (port === undefined) throw new Error('could not reserve a smoke-test port')
  return port
}

async function smokeDashboard(executable: string, stateHome: string): Promise<void> {
  const port = await freePort()
  const args = ['hub', 'serve', '--port', String(port)]
  const rendered = [executable, ...args].join(' ')
  const child = Bun.spawn([executable, ...args], {
    env: smokeEnvironment(stateHome),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  try {
    let response: Response | undefined
    let failure: unknown
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/`)
        break
      } catch (error) {
        failure = error
        await Bun.sleep(50)
      }
    }
    if (!response) throw new Error(`${rendered} did not accept requests: ${String(failure)}`)
    const html = await response.text()
    if (response.status !== 200 || !/<[^>]+id=["']root["']/.test(html)) {
      throw new Error(`${rendered} returned ${response.status} without the app root element`)
    }
    const assetPath = html.match(/<script[^>]+src=["']([^"']+-[^"'/]+\.js)["']/)?.[1]
    if (!assetPath) throw new Error(`${rendered} index did not name a hashed JavaScript asset`)
    const asset = await fetch(new URL(assetPath, `http://127.0.0.1:${port}/`))
    const contentType = asset.headers.get('content-type') ?? ''
    if (asset.status !== 200 || !contentType.includes('javascript')) {
      throw new Error(
        `${rendered} asset ${assetPath} returned ${asset.status} with ${JSON.stringify(contentType)}`,
      )
    }
    console.log(`$ ${rendered}`)
    console.log(`GET / ${response.status}; GET ${assetPath} ${asset.status} ${contentType}`)
    await smoke(executable, ['hub', 'serve-stop', '--port', String(port)], stateHome)
    const exitCode = await Promise.race([
      child.exited,
      Bun.sleep(5_000).then(() => {
        throw new Error(`${rendered} did not exit after serve-stop`)
      }),
    ])
    if (exitCode !== 0) throw new Error(`${rendered} exited ${exitCode}, expected 0`)
    console.log(`server exit ${exitCode}`)
  } finally {
    child.kill()
    const [serverStdout, serverStderr] = await Promise.all([stdout, stderr])
    if (serverStdout.trim()) console.log(serverStdout.trim())
    if (serverStderr.trim()) console.error(serverStderr.trim())
  }
}

try {
  const output = join(scratch, 'bin')
  const stateHome = join(scratch, 'state')
  const binary = await buildHostBinary('v0.1.0', output)
  const orch = join(output, 'orch')
  const hub = join(output, 'hub')
  symlinkSync(binary, orch)
  symlinkSync(binary, hub)
  await smoke(binary, ['--version'], stateHome)
  await smoke(binary, ['orch', '--version'], stateHome)
  await smoke(binary, ['hub', '--version'], stateHome)
  await smoke(hub, ['--help'], stateHome, `hub — every project's tasks in flight`)
  await smoke(binary, ['orch', 'migrate'], stateHome)
  await smoke(binary, ['hub', 'migrate'], stateHome)
  await smoke(orch, ['jobs'], stateHome, 'implement')
  await smoke(binary, ['orch', 'jobs'], stateHome)
  await smoke(binary, ['hub', 'collect', '--only', 'runs'], stateHome, 'collected in')
  await smoke(
    binary,
    ['orch', 'reclaim', 'fixture-questions', '--dry-run'],
    stateHome,
    'no orphan fixture questions found',
  )
  await smoke(
    binary,
    ['orch', 'doc', 'search', 'compiled-child-smoke'],
    stateHome,
    'embedding endpoint could not be established',
    1,
  )
  await smoke(
    binary,
    [...BOTTEGA_ENTRY_PROTOCOL['run-exec'].compiledArguments],
    stateHome,
    '/$bunfs/root/',
    1,
  )
  await smokeDashboard(binary, stateHome)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

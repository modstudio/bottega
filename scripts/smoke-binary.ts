import { Database } from 'bun:sqlite'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { BOTTEGA_ENTRY_PROTOCOL } from '../shared/self-spawn.ts'
import { buildHostBinary } from './build-binary.ts'
import { run } from './build-release.ts'

const scratch = mkdtempSync(join(tmpdir(), `${PLATFORM_SLUG}-smoke-`))
let recordApiUrl: string | undefined
let securityBin: string | undefined

function smokeEnvironment(stateHome: string): Record<string, string | undefined> {
  const env = {
    ...process.env,
    BOTTEGA_STATE_HOME: stateHome,
    CLAUDE_CODE_SESSION_ID: 'DEV-997-binary-smoke',
    ...(recordApiUrl ? { ORCH_RECORD_API_URL: recordApiUrl } : {}),
    ...(securityBin ? { PATH: `${securityBin}:${process.env.PATH ?? ''}` } : {}),
  }
  delete env.ORCH_DB
  delete env.ORCH_DB_WRITE
  delete env.ORCH_RECORD_URL
  delete env.HUB_HOSTED_URL
  delete env.HUB_DB
  return env
}

async function smoke(
  executable: string,
  args: string[],
  stateHome: string,
  expectedOutput?: string,
  expectedExit = 0,
  cwd?: string,
): Promise<string> {
  const rendered = [executable, ...args].join(' ')
  const child = Bun.spawn([executable, ...args], {
    cwd,
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
  return stdout
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

let recordApi: ReturnType<typeof Bun.serve> | null = null
try {
  const output = join(scratch, 'bin')
  const stateHome = join(scratch, 'state')
  securityBin = join(scratch, 'security-bin')
  mkdirSync(securityBin)
  const security = join(securityBin, 'security')
  writeFileSync(security, '#!/bin/sh\nprintf smoke-record-token\n')
  chmodSync(security, 0o755)
  recordApi = Bun.serve({
    port: await freePort(),
    hostname: '127.0.0.1',
    fetch: async (request) => {
      if (request.method !== 'PUT' || new URL(request.url).pathname !== '/v1/projects') {
        return Response.json({ error: 'not found' }, { status: 404 })
      }
      const body = (await request.json()) as { name?: string }
      return Response.json({ name: body.name })
    },
  })
  recordApiUrl = `http://127.0.0.1:${recordApi.port}`
  const binary = await buildHostBinary('v0.1.0', output)
  console.log(`binary size ${statSync(binary).size} bytes`)
  const orch = join(output, 'orch')
  const hub = join(output, 'hub')
  symlinkSync(binary, orch)
  symlinkSync(binary, hub)
  await smoke(binary, ['--version'], stateHome)
  await smoke(binary, ['orch', '--version'], stateHome)
  await smoke(binary, ['hub', '--version'], stateHome)
  await smoke(binary, ['--help'], stateHome)
  await smoke(binary, ['orch', '--help'], stateHome)
  await smoke(binary, ['hub', '--help'], stateHome, `hub — every project's tasks in flight`)
  if (existsSync(stateHome))
    throw new Error('help and version commands created the state directory')
  await smoke(orch, ['jobs'], stateHome, 'implement')
  await smoke(binary, ['orch', 'jobs'], stateHome)
  await smoke(binary, ['hub', 'task', 'list'], stateHome)
  if (!existsSync(join(stateHome, 'orchestrator', 'orch.db'))) {
    throw new Error('orch jobs did not create the orchestrator store')
  }
  if (!existsSync(join(stateHome, 'hub', 'hub.db'))) {
    throw new Error('hub task list did not create the hub store')
  }
  await smoke(
    binary,
    ['hub', 'task', 'new', '--project', 'tasks', '--title', 'smoke'],
    stateHome,
    'TASK-1',
  )
  await smoke(binary, ['hub', 'task', 'list', '--project', 'tasks'], stateHome, 'TASK-1')
  const setupFacts = JSON.parse(
    await smoke(binary, ['orch', 'setup', 'facts', '--json'], stateHome),
  ) as { os?: unknown }
  if (!setupFacts.os) throw new Error('orch setup facts --json returned no os field')
  const setupRepository = join(scratch, 'setup-repository')
  mkdirSync(setupRepository)
  writeFileSync(join(setupRepository, 'README.md'), 'setup binary smoke\n')
  await run(['git', 'init', '--initial-branch=main'], setupRepository)
  await run(['git', 'config', 'user.email', 'smoke@example.invalid'], setupRepository)
  await run(['git', 'config', 'user.name', 'Binary Smoke'], setupRepository)
  await run(['git', 'add', 'README.md'], setupRepository)
  await run(['git', 'commit', '-m', 'DEV-1015 setup smoke fixture'], setupRepository)
  const setupPlan = JSON.parse(
    await smoke(binary, ['orch', 'setup', 'plan', '--in', setupRepository, '--json'], stateHome),
  ) as { diff?: { kind?: string }[] }
  if (setupPlan.diff?.length !== 1 || setupPlan.diff[0]?.kind !== 'add') {
    throw new Error('orch setup plan did not return exactly one add proposal')
  }
  await smoke(binary, ['orch', 'setup', 'apply', '--in', setupRepository, '--yes'], stateHome)
  const setupProjects = JSON.parse(
    await smoke(binary, ['orch', 'project', 'list', '--json'], stateHome),
  ) as { path?: string; settings?: { keyPrefixes?: string[] } }[]
  const setupProject = setupProjects.find(
    (project) => project.path === realpathSync(setupRepository),
  )
  if (!setupProject?.settings?.keyPrefixes?.length) {
    throw new Error('orch setup apply did not register a key prefix')
  }
  const secondSetupPlan = JSON.parse(
    await smoke(binary, ['orch', 'setup', 'plan', '--in', setupRepository, '--json'], stateHome),
  ) as { questions?: unknown[] }
  if (secondSetupPlan.questions?.length !== 0) {
    throw new Error('second orch setup plan returned questions for a configured project')
  }
  const secondSetup = JSON.parse(
    await smoke(
      binary,
      ['orch', 'setup', 'apply', '--in', setupRepository, '--yes', '--json'],
      stateHome,
    ),
  ) as { actions?: { status?: string }[] }
  if (secondSetup.actions?.length !== 1 || secondSetup.actions[0]?.status !== 'unchanged') {
    throw new Error('second orch setup apply did not report unchanged')
  }
  const orchestrator = new Database(join(stateHome, 'orchestrator', 'orch.db'), {
    readonly: true,
  })
  try {
    const seen = orchestrator
      .query('SELECT 1 FROM session_seen WHERE session_id = ?')
      .get('DEV-997-binary-smoke')
    if (!seen) throw new Error('orch jobs did not stamp the invoking session')
  } finally {
    orchestrator.close()
  }
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
  const probeRepository = join(scratch, 'probe-repository')
  mkdirSync(probeRepository)
  writeFileSync(join(probeRepository, 'README.md'), 'binary sandbox smoke\n')
  await run(['git', 'init', '--initial-branch=main'], probeRepository)
  await run(['git', 'config', 'user.email', 'smoke@example.invalid'], probeRepository)
  await run(['git', 'config', 'user.name', 'Binary Smoke'], probeRepository)
  await run(['git', 'add', 'README.md'], probeRepository)
  await run(['git', 'commit', '-m', 'DEV-997 binary smoke fixture'], probeRepository)
  const smokeStore = new Database(join(stateHome, 'orchestrator', 'orch.db'))
  try {
    smokeStore
      .query('INSERT INTO project (name, path, stack, canon, settings) VALUES (?, ?, ?, 0, ?)')
      .run('binary-smoke', realpathSync(probeRepository), 'fixture', '{}')
  } finally {
    smokeStore.close()
  }
  await smoke(
    binary,
    ['orch', 'workflow', 'probe', '--', 'git', 'status', '--short'],
    stateHome,
    undefined,
    0,
    probeRepository,
  )
  const extractedRuntime = join(stateHome, 'runtime', '0.1.0', 'sandbox-runtime')
  if (!existsSync(extractedRuntime)) {
    throw new Error(`sandbox workflow probe did not extract ${extractedRuntime}`)
  }
  console.log(`sandboxed workflow probe extracted ${extractedRuntime}`)
  await smokeDashboard(binary, stateHome)
} finally {
  recordApi?.stop(true)
  rmSync(scratch, { recursive: true, force: true })
}

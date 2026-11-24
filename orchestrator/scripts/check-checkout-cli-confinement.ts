// concern: CI proof that a confined ACP worker can launch checkout bottega-ask.
// The proof runs against this real checkout, which is outside its temporary fixture directory.

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startBounded, startBoundedSync } from '../../shared/bounded-process.ts'
import { PLATFORM_NAME, PLATFORM_SLUG, WORKER_MCP_SERVER_NAME } from '../../shared/brand.ts'
import { CHECKOUT_CLI_BINARY_ENV, CHECKOUT_ROOT_ENV } from '../../shared/install-root.ts'
import { writeRecordSessionToken } from '../../shared/record-session.ts'
import {
  HUB_DATABASE_ENV,
  ORCHESTRATOR_DATABASE_ENV,
  STATE_HOME_ENV,
} from '../../shared/state-directory.ts'
import { WORKER_READ_TOOLS } from '../../shared/worker-read-tools.ts'
import type { Agent } from '../src/agent/agents.ts'
import type { Project } from '../src/project/projects.ts'
import type { TransportStartOpts } from '../src/transport/transport.ts'

const REQUIRED_TOOLS = ['ask_orchestrator', 'note', ...Object.values(WORKER_READ_TOOLS)] as const

const FIXTURE_PROJECT_ID = '01990000-0000-7000-8000-000000002585'
const FIXTURE_TASK_ID = '01990000-0000-7000-8000-000000002586'
const FIXTURE_RUN_ID = 'checkout-cli-confinement'
const FIXTURE_TOKEN = 'checkout-cli-confinement-token'

function fixtureProject(recordId: string, name: string, path: string): Project {
  return {
    recordId,
    name,
    path,
    stack: 'ci',
    canon: false,
    retiredAt: null,
    settings: { keyPrefixes: [] },
  }
}

function migrateTemporaryStore(checkout: string, environment: Record<string, string>): void {
  const result = startBoundedSync([join(checkout, 'bin', PLATFORM_SLUG), 'machine', 'migrate'], {
    budget: 'machine-update',
    cwd: checkout,
    env: environment,
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `temporary store migration failed with exit ${result.exitCode}: ${result.stderr}`,
    )
  }
}

// An ACP agent: codex, grok and qwen take their own home branches, so only such an agent reaches
// prepareSandboxHome's SRT worker-home branch, the home a live confined ACP worker receives.
const SRT_WORKER_HOME_AGENT = 'goose'

function guardRunEnvironment(
  childEnv: typeof import('../src/run/run-process.ts').childEnv,
  agent: Agent,
  environment: Record<string, string>,
  srtWorkerHome: Record<string, string>,
  forceSource: boolean,
): Record<string, string> {
  const extra = { ...environment, ...srtWorkerHome }
  delete extra[STATE_HOME_ENV]
  delete extra.XDG_STATE_HOME
  return childEnv(
    agent,
    'checkout-cli-confinement',
    'checkout-cli-confinement-token',
    extra,
    true,
    undefined,
    {},
    null,
    null,
    false,
    forceSource ? () => false : undefined,
  )
}

async function loadGuardRuntime() {
  const [agents, ask, build, database, probe, hooks, run, sandbox, transport] = await Promise.all([
    import('../src/agent/agents.ts'),
    import('../src/ask/ask.ts'),
    import('../src/database/checkout-cli-build.ts'),
    import('../src/database/db.ts'),
    import('../src/mcp/mcp-probe.ts'),
    import('../src/runtime/store-hooks.ts'),
    import('../src/run/run-process.ts'),
    import('../src/sandbox/sandbox.ts'),
    import('../src/transport/transport-acp.ts'),
  ])
  return { agents, ask, build, database, probe, hooks, run, sandbox, transport }
}

type GuardRuntime = Awaited<ReturnType<typeof loadGuardRuntime>>

function assertCompiledCliDoesNotAutoloadDotenv(
  binary: string,
  checkout: string,
  root: string,
  environment: Record<string, string>,
): void {
  const cwd = mkdtempSync(join(root, 'dotenv-'))
  try {
    writeFileSync(join(cwd, '.env'), `${CHECKOUT_ROOT_ENV}=${checkout}\n`)
    const directEnvironment = { ...environment }
    delete directEnvironment[CHECKOUT_ROOT_ENV]
    const result = startBoundedSync([binary, '--version'], {
      budget: 'machine-update',
      cwd,
      env: directEnvironment,
    })
    if (result.exitCode === 0) {
      throw new Error('compiled checkout CLI autoloaded .env')
    }
    const output = `${result.stdout}\n${result.stderr}`
    if (
      !output.includes(`compiled checkout CLI requires ${CHECKOUT_ROOT_ENV}`) ||
      !output.includes(`run it through bin/${PLATFORM_SLUG}`)
    ) {
      throw new Error(`compiled checkout CLI omitted its missing-root remedy: ${output.trim()}`)
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

function compiledCliVersion(
  binary: string,
  checkout: string,
  cwd: string,
  environment: Record<string, string>,
) {
  return startBoundedSync([binary, '--version'], {
    budget: 'machine-update',
    cwd,
    env: { ...environment, [CHECKOUT_ROOT_ENV]: checkout },
  })
}

function assertCompiledCliDoesNotAutoloadBunfig(
  binary: string,
  checkout: string,
  root: string,
  environment: Record<string, string>,
): void {
  const cwd = mkdtempSync(join(root, 'bunfig-'))
  const marker = join(cwd, 'planted-preload-ran')
  try {
    writeFileSync(join(cwd, 'bunfig.toml'), 'preload = ["./planted.ts"]\n')
    writeFileSync(
      join(cwd, 'planted.ts'),
      `await Bun.write(${JSON.stringify(marker)}, 'planted')\n`,
    )
    const result = compiledCliVersion(binary, checkout, cwd, environment)
    if (existsSync(marker)) throw new Error('compiled checkout CLI autoloaded bunfig.toml')
    if (result.exitCode !== 0) {
      throw new Error(
        `compiled checkout CLI bunfig sentinel failed with exit ${result.exitCode}: ${result.stderr.trim()}`,
      )
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

function assertCompiledCliDoesNotAutoloadAliasConfig(
  binary: string,
  checkout: string,
  root: string,
  environment: Record<string, string>,
  config: 'tsconfig.json' | 'package.json',
): void {
  const cwd = mkdtempSync(join(root, `${config.slice(0, -5)}-`))
  const marker = join(cwd, 'planted-alias-ran')
  try {
    if (config === 'tsconfig.json') {
      mkdirSync(join(cwd, 'planted'), { recursive: true })
      writeFileSync(
        join(cwd, config),
        `${JSON.stringify({
          compilerOptions: { baseUrl: '.', paths: { '@guard/*': ['./planted/*'] } },
        })}\n`,
      )
      writeFileSync(
        join(cwd, 'entry.ts'),
        "const path = '@guard/' + 'marker'\ntry { await import(path) } catch {}\n",
      )
      writeFileSync(
        join(cwd, 'planted', 'marker.ts'),
        `await Bun.write(${JSON.stringify(marker)}, 'planted')\n`,
      )
    } else {
      writeFileSync(
        join(cwd, config),
        `${JSON.stringify({ imports: { '#guard-sentinel': './planted.ts' } })}\n`,
      )
      writeFileSync(
        join(cwd, 'entry.ts'),
        "const path = '#guard-' + 'sentinel'\ntry { await import(path) } catch {}\n",
      )
      writeFileSync(
        join(cwd, 'planted.ts'),
        `await Bun.write(${JSON.stringify(marker)}, 'planted')\n`,
      )
    }
    const result = compiledCliVersion(binary, checkout, cwd, {
      ...environment,
      BUN_OPTIONS: '--preload=./entry.ts',
    })
    if (existsSync(marker)) throw new Error(`compiled checkout CLI autoloaded ${config}`)
    if (result.exitCode !== 0) {
      throw new Error(
        `compiled checkout CLI ${config} sentinel failed with exit ${result.exitCode}: ${result.stderr.trim()}`,
      )
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

function assertCompiledCliDoesNotAutoloadRuntimeConfig(
  binary: string,
  checkout: string,
  root: string,
  environment: Record<string, string>,
): void {
  assertCompiledCliDoesNotAutoloadDotenv(binary, checkout, root, environment)
  assertCompiledCliDoesNotAutoloadBunfig(binary, checkout, root, environment)
  assertCompiledCliDoesNotAutoloadAliasConfig(binary, checkout, root, environment, 'tsconfig.json')
  assertCompiledCliDoesNotAutoloadAliasConfig(binary, checkout, root, environment, 'package.json')
}

async function probeConfinedTools(
  runtime: GuardRuntime,
  input: {
    checkout: string
    cwd: string
    runtimeDir: string
    environment: Record<string, string>
    forceSource: boolean
  },
) {
  const runEnvironment = guardRunEnvironment(
    runtime.run.childEnv,
    runtime.agents.BUILTIN_AGENTS.codex!,
    input.environment,
    runtime.sandbox.prepareSandboxHome(SRT_WORKER_HOME_AGENT, input.runtimeDir, process.env, 'srt'),
    input.forceSource,
  )
  if (input.forceSource) {
    if (runEnvironment[CHECKOUT_CLI_BINARY_ENV])
      throw new Error(`forced source guard unexpectedly selected ${CHECKOUT_CLI_BINARY_ENV}`)
  } else if (!runEnvironment[CHECKOUT_CLI_BINARY_ENV]) {
    throw new Error('host judged the checkout binary not current')
  }
  const outside = fixtureProject('outside-project', 'outside-project', input.cwd)
  const profile = runtime.sandbox.readonlyLensProfile({
    worktree: input.cwd,
    runtimeDir: input.runtimeDir,
    scratchDir: input.runtimeDir,
    project: outside,
    registeredProjects: [
      outside,
      fixtureProject(`${PLATFORM_SLUG}-checkout`, PLATFORM_NAME, input.checkout),
    ],
    agent: 'codex',
    environment: input.environment,
    socketDenyPaths: [],
  })
  const opts: TransportStartOpts = {
    agent: runtime.agents.BUILTIN_AGENTS.codex!,
    cwd: input.cwd,
    env: runEnvironment,
    prompt: '',
    outPath: join(input.runtimeDir, 'output'),
    startedAt: Date.now(),
  }
  const server = runtime.transport
    .acpMcpServers(opts)
    .find((entry) => entry.name === WORKER_MCP_SERVER_NAME)
  if (!server || !('command' in server) || !server.command) {
    throw new Error('production ACP worker channel did not return a stdio server')
  }
  return runtime.probe.probeMcpServer({
    server: WORKER_MCP_SERVER_NAME,
    config: {
      name: WORKER_MCP_SERVER_NAME,
      command: server.command,
      args: server.args,
      env: Object.fromEntries((server.env ?? []).map(({ name, value }) => [name, value])),
    },
    cwd: input.cwd,
    env: runEnvironment,
    wrap: (command, args) =>
      runtime.sandbox.sandboxLaunchArgv(profile, command, args, input.runtimeDir, runEnvironment),
  })
}

function installWorkerReadRun(runtime: GuardRuntime, cwd: string): void {
  const database = runtime.database.db()
  database
    .query(
      `INSERT INTO project (record_id,name,path,stack,canon,settings)
       VALUES (?,'confinement-fixture',?,'ci',0,'{"space":"fixture"}')`,
    )
    .run(FIXTURE_PROJECT_ID, cwd)
  database
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,repo,project_record_id,task_record_id,cwd,
        prompt_sha,prompt_bytes,prompt_head,status,launch_key,run_token)
       VALUES (?,1,?,'codex','implement','confinement-fixture',?,?,?,'sha',1,'probe','running','DEV-2585',?)`,
    )
    .run(
      FIXTURE_RUN_ID,
      new Date().toISOString(),
      FIXTURE_PROJECT_ID,
      FIXTURE_TASK_ID,
      cwd,
      FIXTURE_TOKEN,
    )
  runtime.database
    .db()
    .query(
      `INSERT INTO schema_meta(key,value) VALUES ('record_project_spaces',?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    )
    .run(JSON.stringify({ 'confinement-fixture': 'fixture-space' }))
}

function taskFixtureServer() {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      const identity = decodeURIComponent(url.pathname.replace('/v1/tasks/', ''))
      if (!url.pathname.startsWith('/v1/tasks/') || identity === 'DEV-9999')
        return Response.json({ error: 'no task' }, { status: 404 })
      if (identity !== FIXTURE_TASK_ID && identity !== 'DEV-2585')
        return Response.json({ error: 'no task' }, { status: 404 })
      return Response.json({
        task: {
          id: FIXTURE_TASK_ID,
          key: 'DEV-2585',
          project: 'confinement-fixture',
          project_name: 'confinement-fixture',
          project_id: FIXTURE_PROJECT_ID,
          title: 'Confined worker fixture task',
          status: 'active',
          status_category: 'active',
          parent_key: null,
          parent_id: null,
          body: 'fixture body',
          assignee: null,
          opened_at: null,
          closed_at: null,
          source: 'local',
          first_seen: '2026-11-23T00:00:00.000Z',
          last_seen: '2026-11-23T00:00:00.000Z',
          created_at: '2026-11-23T00:00:00.000Z',
          updated_at: '2026-11-23T00:00:00.000Z',
          deleted_at: null,
          next_document_number: 1,
          retired_reason: null,
          revision: 1,
        },
        comments: [],
        documents: [],
      })
    },
  })
}

async function probeConfinedTaskReads(
  runtime: GuardRuntime,
  input: {
    binary: string
    checkout: string
    cwd: string
    runtimeDir: string
    environment: Record<string, string>
  },
): Promise<void> {
  const runEnvironment = guardRunEnvironment(
    runtime.run.childEnv,
    runtime.agents.BUILTIN_AGENTS.codex!,
    input.environment,
    runtime.sandbox.prepareSandboxHome(SRT_WORKER_HOME_AGENT, input.runtimeDir, process.env, 'srt'),
    false,
  )
  const commandEnvironment = { ...runEnvironment, [CHECKOUT_ROOT_ENV]: input.checkout }
  const outside = fixtureProject('outside-project', 'outside-project', input.cwd)
  const profile = runtime.sandbox.readonlyLensProfile({
    worktree: input.cwd,
    runtimeDir: input.runtimeDir,
    scratchDir: input.runtimeDir,
    project: outside,
    registeredProjects: [outside, fixtureProject(PLATFORM_SLUG, PLATFORM_NAME, input.checkout)],
    agent: 'codex',
    environment: input.environment,
    socketDenyPaths: [],
  })
  const execute = async (key: string) =>
    startBounded(
      await runtime.sandbox.sandboxLaunchArgv(
        profile,
        input.binary,
        ['task', 'show', key],
        input.runtimeDir,
        commandEnvironment,
      ),
      { budget: 'machine-update', cwd: input.cwd, env: commandEnvironment },
    )
  const allowed = await execute('DEV-2585')
  if (allowed.exitCode !== 0 || !allowed.stdout.includes('Confined worker fixture task'))
    throw new Error(`confined in-scope task read failed: ${allowed.stderr || allowed.stdout}`)
  const refused = await execute('DEV-9999')
  if (refused.exitCode === 0 || !refused.stderr.includes('run task DEV-2585'))
    throw new Error(`confined out-of-scope task read did not name its scope: ${refused.stderr}`)
}

/**
 * Bun words an unresolvable bare specifier as either "Cannot find package" or
 * "Cannot find module", depending on which import it reaches first; a relative
 * path is a different failure and never matches.
 */
function packageResolutionFailure(error: string): string | null {
  return error.match(/Cannot find (?:package|module) '(?![./])[^']*'/)?.[0] ?? null
}

function fixtureEnvironment(operatorHome: string): Record<string, string> {
  const environment: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    HOME: operatorHome,
    BOTTEGA_RUN_ID: FIXTURE_RUN_ID,
    BOTTEGA_RUN_TOKEN: FIXTURE_TOKEN,
    BOTTEGA_KEYSTORE: 'file',
  }
  delete environment[HUB_DATABASE_ENV]
  delete environment[ORCHESTRATOR_DATABASE_ENV]
  delete environment[STATE_HOME_ENV]
  delete environment.XDG_STATE_HOME
  delete environment[CHECKOUT_CLI_BINARY_ENV]
  delete environment[CHECKOUT_ROOT_ENV]
  return environment
}

async function main(): Promise<void> {
  const checkout = resolve(import.meta.dir, '../..')
  try {
    if (!statSync(join(checkout, '.git')).isDirectory()) throw new Error()
  } catch {
    throw new Error(
      'checkout CLI confinement proof requires a real checkout; run from a real checkout',
    )
  }
  const forceSource = process.argv.includes('--force-source')
  const root = mkdtempSync(join(tmpdir(), `${PLATFORM_SLUG}-checkout-cli-confinement-`))
  const operatorHome = join(root, 'operator-home')
  const cwd = join(root, 'outside-project')
  const runtimeDir = join(root, 'run')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(runtimeDir, { recursive: true })
  const environment = fixtureEnvironment(operatorHome)
  let closeAskLoopback: (() => Promise<void>) | undefined
  let fixtureServer: ReturnType<typeof taskFixtureServer> | undefined
  try {
    migrateTemporaryStore(checkout, environment)
    process.env.HOME = operatorHome
    delete process.env[STATE_HOME_ENV]
    delete process.env.XDG_STATE_HOME
    delete process.env[ORCHESTRATOR_DATABASE_ENV]
    const runtime = await loadGuardRuntime()
    runtime.hooks.registerStandardHooks()
    installWorkerReadRun(runtime, cwd)
    process.env.BOTTEGA_KEYSTORE = 'file'
    writeRecordSessionToken('fixture-record-session')
    fixtureServer = taskFixtureServer()
    process.env.BOTTEGA_HOSTED_URL = `http://127.0.0.1:${fixtureServer.port}`
    environment.BOTTEGA_KEYSTORE = 'file'
    environment.BOTTEGA_HOSTED_URL = process.env.BOTTEGA_HOSTED_URL
    const askLoopback = await runtime.ask.startAskLoopback(
      'checkout-cli-confinement',
      'checkout-cli-confinement-token',
    )
    closeAskLoopback = askLoopback.close
    environment.BOTTEGA_ASK_URL = askLoopback.url
    const built = runtime.build.buildCheckoutCli(checkout, environment)
    runtime.build.verifyCheckoutCliBuild(built)
    assertCompiledCliDoesNotAutoloadRuntimeConfig(built.binary, checkout, root, environment)
    const result = await probeConfinedTools(runtime, {
      checkout,
      cwd,
      runtimeDir,
      environment,
      forceSource,
    })
    if (!result.ok) {
      const error = result.error ?? 'unknown MCP probe failure'
      const resolution = packageResolutionFailure(error)
      if (forceSource && resolution) {
        console.log(`forced source launch failed with the package-resolution error: ${resolution}`)
        return
      }
      if (!forceSource && resolution) {
        throw new Error(`confined ask-server fell back to source: ${error}`)
      }
      throw new Error(`confined ask-server tools/list failed: ${error}`)
    }
    if (forceSource)
      throw new Error(
        `forced source launch unexpectedly reached confined ${WORKER_MCP_SERVER_NAME} tools`,
      )
    const listed = new Set(result.listedTools ?? [])
    const missing = REQUIRED_TOOLS.filter((name) => !listed.has(name))
    if (missing.length > 0)
      throw new Error(`confined ask-server omitted tools: ${missing.join(', ')}`)
    await probeConfinedTaskReads(runtime, {
      binary: built.binary,
      checkout,
      cwd,
      runtimeDir,
      environment,
    })
    console.log(`confined checkout ask-server listed ${result.listedTools?.length ?? 0} tools`)
  } finally {
    await closeAskLoopback?.()
    await fixtureServer?.stop(true)
    const { resetSandbox } = await import('../src/sandbox/sandbox.ts')
    await resetSandbox()
    rmSync(root, { recursive: true, force: true })
  }
}

await main()

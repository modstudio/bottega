// concern: CI proof that a confined ACP worker can launch checkout bottega-ask.

import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startBoundedSync } from '../../shared/bounded-process.ts'
import { PLATFORM_NAME, PLATFORM_SLUG, WORKER_MCP_SERVER_NAME } from '../../shared/brand.ts'
import { CHECKOUT_CLI_BINARY_ENV, CHECKOUT_ROOT_ENV } from '../../shared/install-root.ts'
import { ORCHESTRATOR_DATABASE_ENV, STATE_HOME_ENV } from '../../shared/state-directory.ts'
import type { Agent } from '../src/agent/agents.ts'
import type { Project } from '../src/project/projects.ts'
import type { TransportStartOpts } from '../src/transport/transport.ts'

const REQUIRED_TOOLS = ['ask_orchestrator', 'note'] as const

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

function guardRunEnvironment(
  childEnv: typeof import('../src/run/run-process.ts').childEnv,
  agent: Agent,
  environment: Record<string, string>,
  forceSource: boolean,
): Record<string, string> {
  return childEnv(
    agent,
    'checkout-cli-confinement',
    'checkout-cli-confinement-token',
    environment,
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
  const [agents, ask, build, probe, hooks, run, sandbox, transport] = await Promise.all([
    import('../src/agent/agents.ts'),
    import('../src/ask/ask.ts'),
    import('../src/database/checkout-cli-build.ts'),
    import('../src/mcp/mcp-probe.ts'),
    import('../src/runtime/store-hooks.ts'),
    import('../src/run/run-process.ts'),
    import('../src/sandbox/sandbox.ts'),
    import('../src/transport/transport-acp.ts'),
  ])
  return { agents, ask, build, probe, hooks, run, sandbox, transport }
}

type GuardRuntime = Awaited<ReturnType<typeof loadGuardRuntime>>

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
    environment: runEnvironment,
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
  const stateRoot = join(root, 'state')
  const cwd = join(root, 'outside-project')
  const runtimeDir = join(root, 'run')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(runtimeDir, { recursive: true })
  const environment: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    [STATE_HOME_ENV]: stateRoot,
    BOTTEGA_RUN_ID: 'checkout-cli-confinement',
    BOTTEGA_RUN_TOKEN: 'checkout-cli-confinement-token',
  }
  delete environment[ORCHESTRATOR_DATABASE_ENV]
  delete environment[CHECKOUT_CLI_BINARY_ENV]
  delete environment[CHECKOUT_ROOT_ENV]
  let closeAskLoopback: (() => Promise<void>) | undefined
  try {
    migrateTemporaryStore(checkout, environment)
    process.env[STATE_HOME_ENV] = stateRoot
    delete process.env[ORCHESTRATOR_DATABASE_ENV]
    const runtime = await loadGuardRuntime()
    runtime.hooks.registerStandardHooks()
    const askLoopback = await runtime.ask.startAskLoopback(
      'checkout-cli-confinement',
      'checkout-cli-confinement-token',
    )
    closeAskLoopback = askLoopback.close
    environment.BOTTEGA_ASK_URL = askLoopback.url
    const built = runtime.build.buildCheckoutCli(checkout, environment)
    runtime.build.verifyCheckoutCliBuild(built)
    const result = await probeConfinedTools(runtime, {
      checkout,
      cwd,
      runtimeDir,
      environment,
      forceSource,
    })
    if (!result.ok) {
      const error = result.error ?? 'unknown MCP probe failure'
      if (forceSource && error.includes('Cannot find package')) {
        console.log('forced source launch failed with the package-resolution error')
        return
      }
      if (!forceSource && error.includes('Cannot find package')) {
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
    console.log(`confined checkout ask-server listed ${result.listedTools?.length ?? 0} tools`)
  } finally {
    await closeAskLoopback?.()
    const { resetSandbox } = await import('../src/sandbox/sandbox.ts')
    await resetSandbox()
    rmSync(root, { recursive: true, force: true })
  }
}

await main()

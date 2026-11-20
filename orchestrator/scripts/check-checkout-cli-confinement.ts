// concern: CI proof that a confined ACP worker can launch checkout bottega-ask.

import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { startBoundedSync } from '../../shared/bounded-process.ts'
import { PLATFORM_NAME, PLATFORM_SLUG, WORKER_MCP_SERVER_NAME } from '../../shared/brand.ts'
import { resolveOrchestratorDatabase, STATE_HOME_ENV } from '../../shared/state-directory.ts'
import { BUILTIN_AGENTS } from '../src/agent/agents.ts'
import { buildCheckoutCli, verifyCheckoutCliBuild } from '../src/database/checkout-cli-build.ts'
import { probeMcpServer } from '../src/mcp/mcp-probe.ts'
import type { Project } from '../src/project/projects.ts'
import { childEnv } from '../src/run/run-process.ts'
import { readonlyLensProfile, resetSandbox, sandboxLaunchArgv } from '../src/sandbox/sandbox.ts'
import type { TransportStartOpts } from '../src/transport/transport.ts'
import { acpWorkerChannel } from '../src/transport/transport-acp.ts'

const REQUIRED_TOOLS = ['ask_orchestrator', 'note', 'run_check'] as const

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
  const store = environment.BOTTEGA_ORCHESTRATOR_DB
  if (!store) throw new Error('temporary store path is missing')
  mkdirSync(dirname(store), { recursive: true })
  new Database(store, { create: true }).close()
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
  environment: Record<string, string>,
  forceSource: boolean,
): Record<string, string> {
  return childEnv(
    BUILTIN_AGENTS.codex!,
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
  const environment = {
    ...process.env,
    [STATE_HOME_ENV]: stateRoot,
    BOTTEGA_ORCHESTRATOR_DB: resolveOrchestratorDatabase({ [STATE_HOME_ENV]: stateRoot }),
    BOTTEGA_RUN_ID: 'checkout-cli-confinement',
    BOTTEGA_RUN_TOKEN: 'checkout-cli-confinement-token',
    BOTTEGA_ASK_URL: 'http://127.0.0.1:1',
  } as Record<string, string>
  try {
    migrateTemporaryStore(checkout, environment)
    const built = buildCheckoutCli(checkout, environment)
    verifyCheckoutCliBuild(built)
    const runEnvironment = guardRunEnvironment(environment, forceSource)
    const outside = fixtureProject('outside-project', 'outside-project', cwd)
    const registeredProjects = [
      outside,
      fixtureProject(`${PLATFORM_SLUG}-checkout`, PLATFORM_NAME, checkout),
    ]
    const profile = readonlyLensProfile({
      worktree: cwd,
      runtimeDir,
      scratchDir: runtimeDir,
      project: outside,
      registeredProjects,
      agent: 'codex',
      environment: runEnvironment,
      socketDenyPaths: [],
    })
    const opts: TransportStartOpts = {
      agent: BUILTIN_AGENTS.codex!,
      cwd,
      env: runEnvironment,
      prompt: '',
      outPath: join(runtimeDir, 'output'),
      startedAt: Date.now(),
    }
    const server = acpWorkerChannel(opts)[0]
    if (!server || !('command' in server) || !server.command) {
      throw new Error('production ACP worker channel did not return a stdio server')
    }
    const serverEnvironment = Object.fromEntries(
      (server.env ?? []).map(({ name, value }) => [name, value]),
    )
    const result = await probeMcpServer({
      server: WORKER_MCP_SERVER_NAME,
      config: {
        name: WORKER_MCP_SERVER_NAME,
        command: server.command,
        args: server.args,
        env: serverEnvironment,
      },
      cwd,
      env: runEnvironment,
      wrap: (command, args) =>
        sandboxLaunchArgv(profile, command, args, runtimeDir, runEnvironment),
    })
    if (!result.ok) {
      if (forceSource && result.error.includes('Cannot find package')) {
        console.log('forced source launch failed with the package-resolution error')
        return
      }
      throw new Error(`confined ask-server tools/list failed: ${result.error}`)
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
    await resetSandbox()
    rmSync(root, { recursive: true, force: true })
  }
}

await main()

import { afterEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { classifyCaller } from '../../../shared/caller-classification.ts'
import { HARNESS_ENV_FILE_ENV, PLATFORM_ENV_FILE_ENV } from '../../../shared/config-directory.ts'
import {
  HUB_DATABASE_ENV,
  resolveHubDatabase,
  STATE_HOME_ENV,
} from '../../../shared/state-directory.ts'
import type { Agent } from '../agent/agents.ts'
import type { Project } from '../project/projects.ts'
import { RequiredMcpProbeRefusalError } from '../sandbox/project-mcp-preflight.ts'
import { grokAskCommandFromConfig, grokAskServerCommand } from '../sandbox/sandbox.ts'
import { workerStateEnvironment } from '../sandbox/worker-sandbox-environment.ts'
import { carriedRefusalFailure } from './run-prelaunch-refusal.ts'
import {
  prepareClaimedWorkerMcpConfig,
  prepareWorkerHomeLaunch,
  runTempEnvironment,
  workerChildEnvironment,
} from './run-worker-home.ts'

const FRONT_DOOR = join('/', 'bin', PLATFORM_SLUG)
const roots: string[] = []
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

test('a workflow probe pins the worker hub store beneath the configured state home', () => {
  const environment = { [STATE_HOME_ENV]: '/fixtures/state' }
  expect(workerStateEnvironment(environment)).toEqual({
    [HUB_DATABASE_ENV]: resolveHubDatabase(environment),
  })
})

test('every launch uses its run-owned temp', () => {
  const runtimeDir = '/runs/sandbox-root'
  const privateTemp = join(runtimeDir, 'tmp')
  expect(runTempEnvironment(privateTemp)).toEqual({
    TMPDIR: privateTemp,
    TMP: privateTemp,
    TEMP: privateTemp,
    CLAUDE_CODE_TMPDIR: privateTemp,
  })
})

test('a writer gets cwd-discovered MCP configuration and a reader does not', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-claimed-mcp-'))
  roots.push(root)
  const checkout = join(root, 'checkout')
  const reader = join(root, 'reader')
  const writer = join(root, 'writer')
  mkdirSync(checkout)
  mkdirSync(reader)
  mkdirSync(writer)
  writeFileSync(join(checkout, '.mcp.json'), '{}\n')

  expect(
    prepareClaimedWorkerMcpConfig({
      cwd: reader,
      checkout,
      inherited: false,
      writesRepository: false,
    }),
  ).toBeNull()
  expect(existsSync(join(reader, '.mcp.json'))).toBe(false)

  const prepared = prepareClaimedWorkerMcpConfig({
    cwd: writer,
    checkout,
    inherited: false,
    writesRepository: true,
  })
  expect(prepared?.error).toBeNull()
  expect(readlinkSync(join(writer, '.mcp.json'))).toBe('../checkout/.mcp.json')
})

const grokAgent = { name: 'grok', harness: 'grok' } as Agent

test('the shared worker child shaper pins state, disables env files and classifies the caller', () => {
  const environment = workerChildEnvironment({
    agent: grokAgent,
    sandbox: 'srt',
    runRecordId: 'probe-run',
    runToken: 'probe-token',
    runNumber: 44,
    environment: { BOTTEGA_STATE_HOME: '/fixture/state' },
    stateEnvironment: { BOTTEGA_HUB_DB: '/fixture/hub.db' },
    includeStore: true,
  })
  expect(classifyCaller(environment)).toEqual({ kind: 'worker' })
  expect(environment.BOTTEGA_HUB_DB).toBe('/fixture/hub.db')
  expect(environment[HARNESS_ENV_FILE_ENV]).toBe('')
  expect(environment[PLATFORM_ENV_FILE_ENV]).toBe('')
})

test('Grok launch scopes only a reader home while leaving a writer direct', async () => {
  const operatorHub = resolveHubDatabase(process.env)
  const root = mkdtempSync(join(tmpdir(), 'orch-grok-launch-'))
  roots.push(root)
  const readerRun = join(root, 'reader-run')
  const reader = join(root, 'reader')
  mkdirSync(readerRun)
  mkdirSync(join(reader, '.grok'), { recursive: true })
  mkdirSync(join(reader, '.cursor'))
  writeFileSync(
    join(readerRun, 'config.toml'),
    '[mcp_servers.project]\ncommand = "user-direct"\n[mcp_servers.alias]\ncommand = "user-alias"\n',
  )
  writeFileSync(
    join(reader, '.grok', 'config.toml'),
    '[mcp_servers.project]\ncommand="tree-direct"\n',
  )
  writeFileSync(join(reader, '.mcp.json'), '{"mcpServers":{"alias":{"command":"mcp-direct"}}}')
  writeFileSync(
    join(reader, '.cursor', 'mcp.json'),
    '{"mcpServers":{"cursor":{"command":"cursor-direct"}}}',
  )
  const proxies = {
    project: {
      command: FRONT_DOOR,
      args: ['mcp-reader-proxy', 'reader', 'fixture', 'project', reader],
    },
  }

  const readerLaunch = await prepareWorkerHomeLaunch({
    agent: grokAgent,
    sandbox: 'host',
    runDir: readerRun,
    runNumber: 41,
    runRecordId: '41000000-0000-4000-8000-000000000000',
    runToken: 'token',
    environment: {},
    grokEnvironment: {},
    includeStore: true,
    mcpLaunch: { codex: null, grok: proxies, projectSelection: null, headerMismatches: [] },
    mcpMode: null,
    project: null,
  })
  const readerHome = readFileSync(join(readerRun, 'config.toml'), 'utf8')
  expect(readerHome).toContain('mcp-reader-proxy')
  expect(readerHome).not.toContain('user-direct')
  expect(readerHome).not.toContain('user-alias')
  expect(grokAskCommandFromConfig(readerHome)).toEqual(grokAskServerCommand('host'))
  expect(readFileSync(join(reader, '.grok', 'config.toml'), 'utf8')).toContain('tree-direct')
  expect(readFileSync(join(reader, '.mcp.json'), 'utf8')).toContain('mcp-direct')
  expect(readFileSync(join(reader, '.cursor', 'mcp.json'), 'utf8')).toContain('cursor-direct')
  expect(readerLaunch.environment.GROK_CURSOR_MCPS_ENABLED).toBe('0')
  expect(readerLaunch.environment.HOME).toBe(join(readerRun, 'home'))
  expect(readerLaunch.environment.BOTTEGA_HUB_DB).toBe(operatorHub)

  const writerRun = join(root, 'writer-run')
  const writer = join(root, 'writer')
  mkdirSync(writerRun)
  mkdirSync(writer)
  writeFileSync(
    join(writerRun, 'config.toml'),
    '[mcp_servers.project]\ncommand = "writer-direct"\n',
  )
  writeFileSync(join(writer, '.mcp.json'), '{"mcpServers":{"project":{"command":"writer-tree"}}}')
  const writerLaunch = await prepareWorkerHomeLaunch({
    agent: grokAgent,
    sandbox: 'host',
    runDir: writerRun,
    runNumber: 42,
    runRecordId: '42000000-0000-4000-8000-000000000000',
    runToken: 'token',
    environment: {},
    grokEnvironment: {},
    includeStore: false,
    mcpLaunch: { codex: null, grok: null, projectSelection: null, headerMismatches: [] },
    mcpMode: null,
    project: null,
  })
  expect(readFileSync(join(writerRun, 'config.toml'), 'utf8')).toContain('writer-direct')
  expect(readFileSync(join(writer, '.mcp.json'), 'utf8')).toContain('writer-tree')
  expect(writerLaunch.environment.GROK_CURSOR_MCPS_ENABLED).toBeUndefined()
})

const hostAgent = { name: 'qwen', harness: 'qwen' } as Agent
const starship = { name: 'starship', path: '/opt/starship', settings: {} } as unknown as Project

/**
 * One launch at the refusal seam: no run directory is prepared for a host
 * agent, so the only thing this tree does is decide whether the run may start.
 */
function starshipLaunch(input: {
  mcpMode: 'require' | null
  projectSelection: Parameters<typeof prepareWorkerHomeLaunch>[0]['mcpLaunch']['projectSelection']
  project: Project
}) {
  return prepareWorkerHomeLaunch({
    agent: hostAgent,
    sandbox: 'host',
    runDir: join(tmpdir(), 'orch-refusal-run'),
    runNumber: 43,
    runRecordId: '43000000-0000-4000-8000-000000000000',
    runToken: 'token',
    environment: {},
    grokEnvironment: {},
    includeStore: false,
    mcpLaunch: {
      codex: null,
      grok: null,
      projectSelection: input.projectSelection,
      headerMismatches: [],
    },
    mcpMode: input.mcpMode,
    project: input.project,
  })
}

/** The rejection a failed launch gave the run, or null when it resolved. */
async function rejection(promise: Promise<unknown>): Promise<Error | null> {
  return promise.then(
    () => null,
    (cause: unknown) => cause as Error,
  )
}

test('--mcp require refuses a run whose required project launch cannot start', async () => {
  // A closed loopback port: the launch affirmatively fails and nothing is spawned.
  const selection = {
    kind: 'direct' as const,
    servers: { starship: { url: 'http://127.0.0.1:1/mcp' } },
    withheld: [],
  }
  const error = await rejection(
    starshipLaunch({ mcpMode: 'require', projectSelection: selection, project: starship }),
  )

  expect(error).toBeInstanceOf(RequiredMcpProbeRefusalError)
  expect(error?.message).toContain(
    '--mcp require was asked for, but the project MCP launch did not start',
  )
  expect(error?.message).toContain('starship:')
  // The kind is what run.ts's launch catch records, so the row reads
  // mcp_unverified and routing never reads the agent as the failure.
  expect(carriedRefusalFailure(error)?.failureKind).toBe('mcp_unverified')

  // The same launch under no requested mode resolves: only require refuses.
  await expect(
    starshipLaunch({ mcpMode: null, projectSelection: selection, project: starship }),
  ).resolves.toBeDefined()
})

test('--mcp require refuses a required server the selection never handed over', async () => {
  const error = await rejection(
    starshipLaunch({
      mcpMode: 'require',
      projectSelection: { kind: 'direct', servers: {}, withheld: [] },
      project: starship,
    }),
  )

  // The default required name is the project's own; no probe can see it when
  // the selection never had it, so the gate itself must name the hole.
  expect(error).toBeInstanceOf(RequiredMcpProbeRefusalError)
  expect(error?.message).toContain('starship: not configured in the tree')
  expect(carriedRefusalFailure(error)?.failureKind).toBe('mcp_unverified')
})

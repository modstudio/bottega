import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { dir } from '../../test/fixtures/store.ts'
import { DEFERRED_CWD_MCP_STEPS, decideDeferredCwdMcpPlan } from '../mcp/mcp-preflight.ts'
import { upsertProject } from '../project/projects.ts'
import { AgentCapacityError } from '../route/routing-refusal.ts'
import { provisionMcpConfig } from '../worktree/worktree-mcp.ts'
import { waitForAgentSelection } from './run-agent-capacity.ts'
import { detachMcpPreflightedAgent } from './run-dispatch.ts'
import { prepareRunMcpPreflight, selectAgentAndPreflightMcp } from './run-mcp-main-stack.ts'

const directories: string[] = []
afterEach(() => {
  mock.restore()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test('the deferred cwd MCP plan fixes deferral before stack enforcement and worker provisioning', () => {
  const deferredFacts = {
    mcpRequest: true,
    callerCwdHasProject: true,
    forbidsRepo: false,
    repoJob: true,
    discoversMcpFromCwd: true,
  } as const
  expect(decideDeferredCwdMcpPlan(deferredFacts)).toEqual([
    'defer-cwd-preflight',
    'ensure-main-stack',
    'provision-worker-mcp',
  ])
  expect(decideDeferredCwdMcpPlan(deferredFacts)).toEqual([...DEFERRED_CWD_MCP_STEPS])
})

test.each([
  { name: 'no MCP request', facts: { mcpRequest: undefined } },
  { name: 'no caller project', facts: { callerCwdHasProject: false } },
  {
    name: 'repository agent without cwd discovery',
    facts: { discoversMcpFromCwd: false },
  },
])('$name selects no deferred cwd MCP steps', ({ facts }) => {
  expect(
    decideDeferredCwdMcpPlan({
      mcpRequest: 'require',
      callerCwdHasProject: true,
      forbidsRepo: false,
      repoJob: true,
      discoversMcpFromCwd: true,
      ...facts,
    }),
  ).toEqual([])
})

test('a repository-forbidden job defers MCP without cwd discovery', () => {
  expect(
    decideDeferredCwdMcpPlan({
      mcpRequest: 'require',
      callerCwdHasProject: true,
      forbidsRepo: true,
      repoJob: false,
      discoversMcpFromCwd: false,
    }),
  ).toEqual([...DEFERRED_CWD_MCP_STEPS])
})

test('foreground MCP preflight executes the declared main-stack step before probing', () => {
  const repository = fixtureDirectory('foreground-mcp-stack-')
  registerMcpProject('foreground-mcp-stack-fixture', repository)
  const dockerCalls = stubDockerFailure()

  expect(() =>
    prepareRunMcpPreflight({
      mcpRequest: true,
      callerCwd: repository,
      projectName: 'foreground-mcp-stack-fixture',
      forbidsRepo: false,
      repoJob: true,
      discoversMcpFromCwd: false,
      agent: 'codex',
    }),
  ).toThrow('daemon unavailable')
  expect(dockerCalls.filter((call) => call[1] === 'compose')).toEqual([
    ['docker', 'compose', 'ps', '--status', 'running', '--services', 'db'],
  ])
})

test('coordinator MCP preflight runs after its capacity wait selects an agent', async () => {
  let attempts = 0
  let now = 0
  const order: string[] = []
  const selected = await selectAgentAndPreflightMcp({
    select: () =>
      waitForAgentSelection({
        select: () => {
          attempts++
          order.push(`select-${attempts}`)
          if (attempts === 1) throw new AgentCapacityError('at capacity')
          return { agent: 'codex', reason: 'capacity available' }
        },
        now: () => now,
        sleep: async (ms) => {
          now += ms
        },
      }),
    mcpRequest: 'require',
    cwd: process.cwd(),
    job: 'craft',
    preflight: (input) => order.push(`preflight-${input.selectedAgent}-${input.mcpRequest}`),
  })

  expect(selected).toEqual({ agent: 'codex', reason: 'capacity available' })
  expect(order).toEqual(['select-1', 'select-2', 'preflight-codex-require'])
})

test('coordinator skips MCP preflight only for the agent already checked', async () => {
  let calls = 0
  const selected = await selectAgentAndPreflightMcp({
    select: async () => ({ agent: 'codex', reason: 'selected' }),
    mcpRequest: 'require',
    cwd: process.cwd(),
    job: 'craft',
    preflightedAgent: 'codex',
    preflight: () => calls++,
  })

  expect(selected.agent).toBe('codex')
  expect(calls).toBe(0)
})

test('coordinator runs MCP preflight when failover selects a different agent', async () => {
  const calls: string[] = []
  const selected = await selectAgentAndPreflightMcp({
    select: async () => ({ agent: 'claude', reason: 'failover' }),
    mcpRequest: 'require',
    cwd: process.cwd(),
    job: 'craft',
    preflightedAgent: 'codex',
    preflight: ({ selectedAgent }) => calls.push(selectedAgent),
  })

  expect(selected.agent).toBe('claude')
  expect(calls).toEqual(['claude'])
})

test('detach records the selected agent only for a first-turn MCP preflight', () => {
  expect(
    detachMcpPreflightedAgent({
      firstTurn: true,
      mcpRequest: 'require',
      selectedAgent: 'codex',
    }),
  ).toBe('codex')
  expect(
    detachMcpPreflightedAgent({
      firstTurn: false,
      mcpRequest: 'require',
      selectedAgent: 'codex',
    }),
  ).toBeUndefined()
  expect(
    detachMcpPreflightedAgent({
      firstTurn: true,
      mcpRequest: undefined,
      selectedAgent: 'codex',
    }),
  ).toBeUndefined()
  expect(
    detachMcpPreflightedAgent({
      firstTurn: true,
      mcpRequest: 'require',
      selectedAgent: undefined,
    }),
  ).toBeUndefined()
})

test('worker MCP provisioning executes the final plan step against the worker tree', () => {
  const root = fixtureDirectory('worker-mcp-step-')
  const checkout = join(root, 'checkout')
  const worker = join(root, 'worker')
  mkdirSync(checkout)
  mkdirSync(worker)
  writeFileSync(join(checkout, '.mcp.json'), '{}\n')

  expect(provisionMcpConfig(worker, checkout)).toEqual({
    header: 'MCP preflight: linked .mcp.json -> ../checkout/.mcp.json',
    error: null,
  })
  expect(readlinkSync(join(worker, '.mcp.json'))).toBe('../checkout/.mcp.json')
})

test('a read-only run without an MCP request selects no deferred work or project stack', () => {
  const repository = fixtureDirectory('read-only-no-mcp-stack-')
  registerMcpProject('read-only-no-mcp-stack-fixture', repository)
  const dockerCalls = stubDockerFailure()

  expect(
    prepareRunMcpPreflight({
      mcpRequest: undefined,
      callerCwd: repository,
      projectName: 'read-only-no-mcp-stack-fixture',
      forbidsRepo: false,
      repoJob: true,
      discoversMcpFromCwd: false,
      agent: 'codex',
    }),
  ).toEqual({ deferredCwdMcpPlan: [], mcpConnection: null })
  expect(dockerCalls).toEqual([])
})

function fixtureDirectory(prefix: string): string {
  const directory = mkdtempSync(join(dir, prefix))
  directories.push(directory)
  return directory
}

function registerMcpProject(name: string, path: string): void {
  upsertProject({
    recordId: newRecordId(),
    name,
    path,
    settings: { mainStack: { consumers: ['mcp'], requiredServices: ['db'] } },
  })
}

function stubDockerFailure(): string[][] {
  const calls: string[][] = []
  const originalSpawnSync = Bun.spawnSync
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[], options?: object) => {
    if (args[0] !== 'docker') return originalSpawnSync(args, options as never)
    calls.push(args)
    return {
      exitCode: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from('daemon unavailable'),
      success: false,
      exitedDueToTimeout: false,
    } as ReturnType<typeof Bun.spawnSync>
  }) as typeof Bun.spawnSync)
  return calls
}

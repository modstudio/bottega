import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { CHECKOUT_CLI_BINARY_ENV } from '../../../shared/install-root.ts'
import { STATE_HOME_ENV } from '../../../shared/state-directory.ts'
import { addRun } from '../../test/fixtures/store.ts'
import {
  AGENTS,
  type AgentRow,
  GOOSE_CONTEXT_CEILING,
  GOOSE_READING_MAX_TURNS,
  rowAgent,
} from '../agent/agent-registry.ts'
import { db } from '../database/db.ts'
import { probeContextLimitEnvironment } from '../dispatch/probe-launch-overrides.ts'
import { job, PROMPT_BYTES_PER_TOKEN } from '../jobs/jobs.ts'
import { checkoutCliBinaryEnvironment } from '../sandbox/checkout-cli-freshness.ts'
import { childEnv, planRunProcessTermination, terminateRunProcesses } from './run-process.ts'

afterEach(() => mock.restore())

describe('checkout CLI selection', () => {
  let fixture: string
  let inheritedHome: string | undefined
  let inheritedStateHome: string | undefined
  let inheritedXdgStateHome: string | undefined

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'orch-run-process-cli-'))
    inheritedHome = process.env.HOME
    inheritedStateHome = process.env[STATE_HOME_ENV]
    inheritedXdgStateHome = process.env.XDG_STATE_HOME
    process.env.HOME = join(fixture, 'operator-home')
    delete process.env[STATE_HOME_ENV]
    delete process.env.XDG_STATE_HOME
  })

  afterEach(() => {
    if (inheritedHome === undefined) delete process.env.HOME
    else process.env.HOME = inheritedHome
    if (inheritedStateHome === undefined) delete process.env[STATE_HOME_ENV]
    else process.env[STATE_HOME_ENV] = inheritedStateHome
    if (inheritedXdgStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = inheritedXdgStateHome
    rmSync(fixture, { recursive: true, force: true })
  })

  test('an SRT worker home receives the checkout CLI selected from the host state root', () => {
    const selectedOnHost = checkoutCliBinaryEnvironment(process.env, () => true)[
      CHECKOUT_CLI_BINARY_ENV
    ]!
    mkdirSync(dirname(selectedOnHost), { recursive: true })
    writeFileSync(selectedOnHost, 'fixture binary')
    writeFileSync(`${selectedOnHost}.stamp`, 'fixture stamp')

    const child = childEnv(
      AGENTS.codex!,
      undefined,
      undefined,
      { HOME: join(fixture, 'worker-home') },
      false,
      undefined,
      {},
      null,
      null,
      false,
      (facts) => facts.stampContents === 'fixture stamp' && facts.binaryStat !== null,
    )

    expect(child.HOME).toBe(join(fixture, 'worker-home'))
    expect(child[STATE_HOME_ENV]).toBeUndefined()
    expect(child[CHECKOUT_CLI_BINARY_ENV]).toBe(selectedOnHost)
  })
})

test('repository workers receive test caps while inline workers do not', () => {
  const defaults = childEnv(AGENTS.codex!, undefined, undefined, {}, true)
  expect(defaults.BOTTEGA_TEST_WORKERS).toBeDefined()
  expect(defaults.VITEST_MAX_WORKERS).toBe(defaults.BOTTEGA_TEST_WORKERS)
  expect(childEnv(AGENTS.codex!, undefined, undefined, {}, false)).not.toHaveProperty(
    'BOTTEGA_TEST_WORKERS',
  )
})

test('codex workers enable the retry warning log without trace volume', () => {
  expect(childEnv(AGENTS.codex!, undefined, undefined, {}, false).RUST_LOG).toBe('codex_core=warn')
})

test('a worker replaces an inherited checkout CLI binary only when the host selects one', () => {
  const inherited = process.env[CHECKOUT_CLI_BINARY_ENV]
  process.env[CHECKOUT_CLI_BINARY_ENV] = '/foreign/checkout-cli'
  try {
    const rejected = childEnv(
      AGENTS.codex!,
      undefined,
      undefined,
      {},
      false,
      undefined,
      {},
      null,
      null,
      false,
      () => false,
    )
    expect(rejected[CHECKOUT_CLI_BINARY_ENV]).toBeUndefined()

    const selected = childEnv(
      AGENTS.codex!,
      undefined,
      undefined,
      {},
      false,
      undefined,
      {},
      null,
      null,
      false,
      () => true,
    )
    expect(selected[CHECKOUT_CLI_BINARY_ENV]).toBe(
      checkoutCliBinaryEnvironment(selected, () => true)[CHECKOUT_CLI_BINARY_ENV],
    )
    expect(selected[CHECKOUT_CLI_BINARY_ENV]).not.toBe('/foreign/checkout-cli')
  } finally {
    if (inherited === undefined) delete process.env[CHECKOUT_CLI_BINARY_ENV]
    else process.env[CHECKOUT_CLI_BINARY_ENV] = inherited
  }
})

test('worker context controls override inherited values only for grok', () => {
  const parentAgents = process.env.GROK_CLAUDE_AGENTS_ENABLED
  const parentHooks = process.env.GROK_CLAUDE_HOOKS_ENABLED
  const parentMcps = process.env.GROK_CLAUDE_MCPS_ENABLED
  const parentSkills = process.env.GROK_CLAUDE_SKILLS_ENABLED
  process.env.GROK_CLAUDE_AGENTS_ENABLED = '1'
  process.env.GROK_CLAUDE_HOOKS_ENABLED = '1'
  process.env.GROK_CLAUDE_MCPS_ENABLED = '1'
  process.env.GROK_CLAUDE_SKILLS_ENABLED = '1'
  try {
    expect(childEnv(AGENTS.grok!, undefined, undefined, {}, false)).toMatchObject({
      GROK_CLAUDE_AGENTS_ENABLED: '0',
      GROK_CLAUDE_HOOKS_ENABLED: '0',
      GROK_CLAUDE_MCPS_ENABLED: '0',
      GROK_CLAUDE_SKILLS_ENABLED: '0',
    })
    expect(childEnv(AGENTS.codex!, undefined, undefined, {}, false)).toMatchObject({
      GROK_CLAUDE_AGENTS_ENABLED: '1',
      GROK_CLAUDE_HOOKS_ENABLED: '1',
    })
  } finally {
    if (parentAgents === undefined) delete process.env.GROK_CLAUDE_AGENTS_ENABLED
    else process.env.GROK_CLAUDE_AGENTS_ENABLED = parentAgents
    if (parentHooks === undefined) delete process.env.GROK_CLAUDE_HOOKS_ENABLED
    else process.env.GROK_CLAUDE_HOOKS_ENABLED = parentHooks
    if (parentMcps === undefined) delete process.env.GROK_CLAUDE_MCPS_ENABLED
    else process.env.GROK_CLAUDE_MCPS_ENABLED = parentMcps
    if (parentSkills === undefined) delete process.env.GROK_CLAUDE_SKILLS_ENABLED
    else process.env.GROK_CLAUDE_SKILLS_ENABLED = parentSkills
  }
})

test('worker context controls follow a registered agent harness rather than its name', () => {
  const variant = { ...AGENTS.grok!, name: 'grok-variant', harness: 'grok' }
  expect(childEnv(variant, undefined, undefined, {}, false)).toMatchObject({
    GROK_CLAUDE_AGENTS_ENABLED: '0',
    GROK_CLAUDE_HOOKS_ENABLED: '0',
    GROK_CLAUDE_MCPS_ENABLED: '0',
    GROK_CLAUDE_SKILLS_ENABLED: '0',
  })
})

test('a probe context override wins over the ceilinged Goose child environment', () => {
  const row = db().query("SELECT * FROM agent WHERE name = 'codex'").get() as AgentRow
  const { contextTokens: _contextTokens, ...caps } = JSON.parse(row.caps)
  const goose = rowAgent({
    ...row,
    name: 'probe-goose',
    harness: 'goose',
    model: 'probe-model',
    base_url: 'http://model.test',
    caps: JSON.stringify({ ...caps, contextTokens: 200_000 }),
  })
  const extra = probeContextLimitEnvironment(180_000, goose.servedContextTokens)
  expect(
    childEnv(
      goose,
      undefined,
      undefined,
      extra,
      false,
      undefined,
      {},
      job('review-lens').contextTokens,
    ).GOOSE_CONTEXT_LIMIT,
  ).toBe('180000')
})

test('a parent environment holding both record URLs yields a child environment holding neither', () => {
  const priorUrl = process.env.BOTTEGA_RECORD_URL
  const priorMigrate = process.env.BOTTEGA_RECORD_MIGRATE_URL
  const priorOther = process.env.BOTTEGA_OTHER
  process.env.BOTTEGA_RECORD_URL = 'postgres://record.test/database'
  process.env.BOTTEGA_RECORD_MIGRATE_URL = 'postgres://record.test/migrate'
  process.env.BOTTEGA_OTHER = 'keep'
  try {
    const child = childEnv(AGENTS.grok!, undefined, undefined, {}, false)
    expect(child.BOTTEGA_RECORD_URL).toBeUndefined()
    expect(child.BOTTEGA_RECORD_MIGRATE_URL).toBeUndefined()
    expect(child.BOTTEGA_OTHER).toBe('keep')
  } finally {
    if (priorUrl === undefined) delete process.env.BOTTEGA_RECORD_URL
    else process.env.BOTTEGA_RECORD_URL = priorUrl
    if (priorMigrate === undefined) delete process.env.BOTTEGA_RECORD_MIGRATE_URL
    else process.env.BOTTEGA_RECORD_MIGRATE_URL = priorMigrate
    if (priorOther === undefined) delete process.env.BOTTEGA_OTHER
    else process.env.BOTTEGA_OTHER = priorOther
  }
})

test('a Codex worker environment uses its chain-scoped CODEX_HOME', () => {
  expect(
    childEnv(AGENTS.codex!, undefined, undefined, { CODEX_HOME: '/runs/sandbox-41/codex' }, false)
      .CODEX_HOME,
  ).toBe('/runs/sandbox-41/codex')
})

test('a worker receives UUID machine identity, a separate display number and its agent', () => {
  const recordId = '42000000-0000-4000-8000-000000000000'
  expect(childEnv(AGENTS.codex!, recordId, 'token', {}, false, 42)).toMatchObject({
    BOTTEGA_RUN_ID: recordId,
    BOTTEGA_RUN_NUMBER: '42',
    BOTTEGA_RUN_TOKEN: 'token',
    BOTTEGA_AGENT: AGENTS.codex!.name,
  })
})

const FILED_DEFECT_BIRTH = 'Thu Oct  8 12:00:00 2026'
const filedDefectInventory = (coordinator: number, vendor: number) => ({
  ascertainable: true as const,
  rows: [
    {
      pid: coordinator,
      ppid: 1,
      pgid: coordinator,
      command: 'bun orchestrator/src/cli.ts fix-defect DEV-1234',
    },
    {
      pid: vendor,
      ppid: coordinator,
      pgid: vendor,
      command: 'codex exec --json',
    },
  ],
})

test('filed-defect stop verifies the vendor pid, not the shared coordinator command', () => {
  const plan = planRunProcessTermination({
    recorded: {
      pid: 42402,
      agentPid: 42922,
      agentPgid: 42922,
      agentStartTime: FILED_DEFECT_BIRTH,
    },
    vendorIdentity: 'live',
    inventory: filedDefectInventory(42402, 42922),
    exclude: [42402],
    selfPid: 9001,
    selfPgid: 1,
  })
  expect(plan).toEqual({
    outcome: 'verified',
    rootPid: 42922,
    pids: [42922],
    pgid: 42922,
    signalGroup: true,
  })
})

test('filed-defect identity mismatch plans no signals', () => {
  expect(
    planRunProcessTermination({
      recorded: {
        pid: 42402,
        agentPid: 42922,
        agentPgid: 42922,
        agentStartTime: FILED_DEFECT_BIRTH,
      },
      vendorIdentity: 'unknown',
      inventory: filedDefectInventory(42402, 42922),
      exclude: [42402],
      selfPid: 9001,
    }),
  ).toEqual({ outcome: 'identity-mismatch', pid: 42922 })
  expect(
    planRunProcessTermination({
      recorded: {
        pid: 42402,
        agentPid: 42922,
        agentPgid: 42922,
        agentStartTime: FILED_DEFECT_BIRTH,
      },
      vendorIdentity: 'reused',
      inventory: filedDefectInventory(42402, 42922),
      exclude: [42402],
      selfPid: 9001,
    }),
  ).toEqual({ outcome: 'identity-mismatch', pid: 42922 })
})

test('filed-defect terminate signals the vendor and leaves the shared coordinator', () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const coordinator = 42402
  const vendor = 42922
  db()
    .query('UPDATE run SET pid=?, agent_pid=?, agent_pgid=?, agent_start_time=? WHERE record_id=?')
    .run(coordinator, vendor, vendor, FILED_DEFECT_BIRTH, id)
  const signaled: number[] = []
  const result = terminateRunProcesses(id, [coordinator], {
    inventory: () => filedDefectInventory(coordinator, vendor),
    identity: () => 'live',
    kill(pid) {
      if (pid > 0) signaled.push(pid)
    },
    alive: () => false,
    wait: () => {},
    confirmMs: 5,
    selfPgid: () => 1,
  })
  expect(result).toEqual({ outcome: 'signaled', signaled: [vendor] })
  expect(signaled).toContain(vendor)
  expect(signaled).not.toContain(coordinator)
})

test('a vendor sharing the coordinator process group does not expand to sibling workers', () => {
  const plan = planRunProcessTermination({
    recorded: {
      pid: 42402,
      agentPid: 42922,
      agentPgid: 42402,
      agentStartTime: FILED_DEFECT_BIRTH,
    },
    vendorIdentity: 'live',
    inventory: {
      ascertainable: true,
      rows: [
        {
          pid: 42402,
          ppid: 1,
          pgid: 42402,
          command: 'bun orchestrator/src/cli.ts fix-defect DEV-1234',
        },
        { pid: 42922, ppid: 42402, pgid: 42402, command: 'codex exec --json' },
        { pid: 43000, ppid: 42402, pgid: 42402, command: 'codex exec --json sibling' },
      ],
    },
    exclude: [42402],
    selfPid: 9001,
  })
  expect(plan.outcome).toBe('verified')
  if (plan.outcome !== 'verified') return
  expect(plan.pids).toEqual([42922])
})

test('filed-defect terminate leaves the row unreaped when the vendor stays alive', () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const coordinator = 42402
  const vendor = 42922
  db()
    .query('UPDATE run SET pid=?, agent_pid=?, agent_pgid=?, agent_start_time=? WHERE record_id=?')
    .run(coordinator, vendor, vendor, FILED_DEFECT_BIRTH, id)
  const result = terminateRunProcesses(id, [coordinator], {
    inventory: () => filedDefectInventory(coordinator, vendor),
    identity: () => 'live',
    kill: () => {},
    alive: () => true,
    wait: () => {},
    confirmMs: 5,
    selfPgid: () => 1,
  })
  expect(result).toEqual({
    outcome: 'still-alive',
    pid: vendor,
    reason: 'process did not exit after SIGKILL',
  })
})

test('a denied vendor signal reports the process still alive', () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const coordinator = 42402
  const vendor = 42922
  db()
    .query('UPDATE run SET pid=?, agent_pid=?, agent_pgid=?, agent_start_time=? WHERE record_id=?')
    .run(coordinator, vendor, vendor, FILED_DEFECT_BIRTH, id)
  spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
  })

  const result = terminateRunProcesses(id, [coordinator], {
    inventory: () => filedDefectInventory(coordinator, vendor),
    identity: () => 'live',
    alive: () => true,
    wait: () => {},
    confirmMs: 5,
    selfPgid: () => 1,
  })

  expect(result).toEqual({
    outcome: 'still-alive',
    pid: vendor,
    reason: 'process did not exit after SIGKILL',
  })
})

test('filed-defect terminate signals nothing when vendor identity does not match', () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const coordinator = 42402
  const vendor = 42922
  db()
    .query('UPDATE run SET pid=?, agent_pid=?, agent_pgid=?, agent_start_time=? WHERE record_id=?')
    .run(coordinator, vendor, vendor, FILED_DEFECT_BIRTH, id)
  const signaled: number[] = []
  const result = terminateRunProcesses(id, [coordinator], {
    inventory: () => filedDefectInventory(coordinator, vendor),
    identity: () => 'unknown',
    kill(pid) {
      if (pid > 0) signaled.push(pid)
    },
    alive: () => true,
    wait: () => {},
    confirmMs: 5,
    selfPgid: () => 1,
  })
  expect(result).toEqual({ outcome: 'identity-mismatch', pid: vendor })
  expect(signaled).toEqual([])
})

test('a run with a coordinator pid and no vendor is a no-vendor plan', () => {
  expect(
    planRunProcessTermination({
      recorded: { pid: 42402, agentPid: null, agentPgid: null, agentStartTime: null },
      vendorIdentity: 'unknown',
      inventory: { ascertainable: true, rows: [] },
      exclude: [42402],
      selfPid: 9001,
    }),
  ).toEqual({ outcome: 'no-vendor' })
})

test('a live vendor pid excluded as the coordinator is a mismatch, not gone', () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const coordinator = 42402
  db()
    .query('UPDATE run SET pid=?, agent_pid=?, agent_pgid=?, agent_start_time=? WHERE record_id=?')
    .run(coordinator, coordinator, coordinator, FILED_DEFECT_BIRTH, id)
  const signaled: number[] = []
  const result = terminateRunProcesses(id, [coordinator], {
    inventory: () => ({
      ascertainable: true,
      rows: [
        {
          pid: coordinator,
          ppid: 1,
          pgid: coordinator,
          command: 'codex exec --json',
        },
      ],
    }),
    identity: () => 'live',
    kill(pid) {
      signaled.push(pid)
    },
    alive: () => true,
    wait: () => {},
    confirmMs: 5,
    selfPgid: () => 1,
  })
  expect(result).toEqual({ outcome: 'identity-mismatch', pid: coordinator })
  expect(signaled).toEqual([])
})

test('an own-group vendor leader receives a negative-pid signal', () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const coordinator = 42402
  const vendor = 42922
  db()
    .query('UPDATE run SET pid=?, agent_pid=?, agent_pgid=?, agent_start_time=? WHERE record_id=?')
    .run(coordinator, vendor, vendor, FILED_DEFECT_BIRTH, id)
  const groups: number[] = []
  terminateRunProcesses(id, [coordinator], {
    inventory: () => filedDefectInventory(coordinator, vendor),
    identity: () => 'live',
    kill(pid) {
      if (pid < 0) groups.push(pid)
    },
    alive: () => false,
    wait: () => {},
    confirmMs: 5,
    selfPgid: () => 1,
  })
  expect(groups).toContain(-vendor)
})

test('a vendor in another group is not group-signaled with or without a coordinator row', () => {
  const coordinator = 42402
  const vendor = 42922
  const sharedGroup = coordinator
  const inventories = [
    {
      ascertainable: true as const,
      rows: [
        {
          pid: coordinator,
          ppid: 1,
          pgid: sharedGroup,
          command: 'bun orchestrator/src/cli.ts fix-defect DEV-1234',
        },
        { pid: vendor, ppid: coordinator, pgid: sharedGroup, command: 'codex exec --json' },
      ],
    },
    {
      ascertainable: true as const,
      rows: [{ pid: vendor, ppid: 1, pgid: sharedGroup, command: 'codex exec --json' }],
    },
    { ascertainable: false as const, reason: 'process inventory unavailable' },
  ]
  for (const inventory of inventories) {
    const id = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    db()
      .query(
        'UPDATE run SET pid=?, agent_pid=?, agent_pgid=?, agent_start_time=? WHERE record_id=?',
      )
      .run(coordinator, vendor, sharedGroup, FILED_DEFECT_BIRTH, id)
    const groups: number[] = []
    terminateRunProcesses(id, [coordinator], {
      inventory: () => inventory,
      identity: () => 'live',
      kill(pid) {
        if (pid < 0) groups.push(pid)
      },
      alive: () => false,
      wait: () => {},
      confirmMs: 5,
      selfPgid: () => 1,
    })
    expect(groups).toEqual([])
  }
})

test('a descendant that survives SIGTERM is SIGKILLed after the root dies', () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const coordinator = 42402
  const vendor = 42922
  const child = 43000
  db()
    .query('UPDATE run SET pid=?, agent_pid=?, agent_pgid=?, agent_start_time=? WHERE record_id=?')
    .run(coordinator, vendor, vendor, FILED_DEFECT_BIRTH, id)
  const killed: Array<{ pid: number; signal: NodeJS.Signals | number }> = []
  const dead = new Set<number>()
  const result = terminateRunProcesses(id, [coordinator], {
    inventory: () => ({
      ascertainable: true,
      rows: [
        {
          pid: coordinator,
          ppid: 1,
          pgid: coordinator,
          command: 'bun orchestrator/src/cli.ts fix-defect DEV-1234',
        },
        { pid: vendor, ppid: coordinator, pgid: vendor, command: 'codex exec --json' },
        { pid: child, ppid: vendor, pgid: vendor, command: 'codex worker' },
      ],
    }),
    identity: () => 'live',
    kill(pid, signal) {
      killed.push({ pid, signal })
      if (signal === 'SIGKILL') dead.add(Math.abs(pid))
    },
    alive: (pid) => pid === child && !dead.has(pid),
    wait: () => {},
    confirmMs: 5,
    selfPgid: () => 1,
  })
  expect(result).toEqual({ outcome: 'signaled', signaled: [vendor, child] })
  expect(killed).toContainEqual({ pid: child, signal: 'SIGKILL' })
})

test('a descendant that survives SIGKILL is still-alive', () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const coordinator = 42402
  const vendor = 42922
  const child = 43000
  db()
    .query('UPDATE run SET pid=?, agent_pid=?, agent_pgid=?, agent_start_time=? WHERE record_id=?')
    .run(coordinator, vendor, vendor, FILED_DEFECT_BIRTH, id)
  const result = terminateRunProcesses(id, [coordinator], {
    inventory: () => ({
      ascertainable: true,
      rows: [
        {
          pid: coordinator,
          ppid: 1,
          pgid: coordinator,
          command: 'bun orchestrator/src/cli.ts fix-defect DEV-1234',
        },
        { pid: vendor, ppid: coordinator, pgid: vendor, command: 'codex exec --json' },
        { pid: child, ppid: vendor, pgid: vendor, command: 'codex worker' },
      ],
    }),
    identity: () => 'live',
    kill: () => {},
    alive: (pid) => pid === child,
    wait: () => {},
    confirmMs: 5,
    selfPgid: () => 1,
  })
  expect(result).toEqual({
    outcome: 'still-alive',
    pid: child,
    reason: 'process did not exit after SIGKILL',
  })
})

test('a goose launch carries the Goose context ceiling', () => {
  const row = db().query("SELECT * FROM agent WHERE name = 'codex'").get() as AgentRow
  const { contextTokens: _contextTokens, ...caps } = JSON.parse(row.caps)
  const goose = rowAgent({
    ...row,
    harness: 'goose',
    model: 'fixture-model',
    base_url: 'http://fixture.invalid/v1',
    caps: JSON.stringify({ ...caps, contextTokens: 1_048_576 }),
  })
  const deep = job('implement').contextTokens
  const promptTokens = 40_000
  expect(
    childEnv(
      goose,
      undefined,
      undefined,
      {},
      true,
      undefined,
      {},
      deep,
      promptTokens * PROMPT_BYTES_PER_TOKEN,
    ).GOOSE_CONTEXT_LIMIT,
  ).toBe(String(GOOSE_CONTEXT_CEILING))
})

test('a goose launch carries the turn ceiling for a reading job and not for a writing job', () => {
  const row = db().query("SELECT * FROM agent WHERE name = 'codex'").get() as AgentRow
  const goose = rowAgent({
    ...row,
    harness: 'goose',
    model: 'fixture-model',
    base_url: 'http://fixture.invalid/v1',
  })
  const launch = (writesRepo: boolean) =>
    childEnv(goose, undefined, undefined, {}, true, undefined, {}, null, null, writesRepo)
  expect(launch(false).GOOSE_MAX_TURNS).toBe(String(GOOSE_READING_MAX_TURNS))
  expect(launch(true).GOOSE_MAX_TURNS).toBeUndefined()
})

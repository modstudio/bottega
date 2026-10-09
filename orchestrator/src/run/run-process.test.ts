import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { AGENTS } from '../agent/agent-registry.ts'
import { db } from '../database/db.ts'
import { childEnv, planRunProcessTermination, terminateRunProcesses } from './run-process.ts'

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

test('a Codex worker environment uses its chain-scoped CODEX_HOME', () => {
  expect(
    childEnv(AGENTS.codex!, undefined, undefined, { CODEX_HOME: '/runs/sandbox-41/codex' }, false)
      .CODEX_HOME,
  ).toBe('/runs/sandbox-41/codex')
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
    .query('UPDATE run SET pid=?, agent_pid=?, agent_pgid=?, agent_start_time=? WHERE id=?')
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
    .query('UPDATE run SET pid=?, agent_pid=?, agent_pgid=?, agent_start_time=? WHERE id=?')
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

test('filed-defect terminate signals nothing when vendor identity does not match', () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const coordinator = 42402
  const vendor = 42922
  db()
    .query('UPDATE run SET pid=?, agent_pid=?, agent_pgid=?, agent_start_time=? WHERE id=?')
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
    .query('UPDATE run SET pid=?, agent_pid=?, agent_pgid=?, agent_start_time=? WHERE id=?')
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
    .query('UPDATE run SET pid=?, agent_pid=?, agent_pgid=?, agent_start_time=? WHERE id=?')
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
      .query('UPDATE run SET pid=?, agent_pid=?, agent_pgid=?, agent_start_time=? WHERE id=?')
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
    .query('UPDATE run SET pid=?, agent_pid=?, agent_pgid=?, agent_start_time=? WHERE id=?')
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
    .query('UPDATE run SET pid=?, agent_pid=?, agent_pgid=?, agent_start_time=? WHERE id=?')
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

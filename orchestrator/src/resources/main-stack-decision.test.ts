import { expect, test } from 'bun:test'
import {
  classifyServedWorktree,
  decideMainStackEnsure,
  decideMainStackIdleStop,
  decideMainStackStopGuard,
  decideTerminalDockerInventory,
  decideWorktreeResourceTeardown,
  mainStackStopGuardReason,
  newlyStartedMainStackServices,
} from './main-stack-decision.ts'

test('main-stack stop guard allows only known-idle liveness', () => {
  const idle = {
    servedWorktree: false as boolean | 'unknown',
    execInProgress: false as boolean | 'unknown',
    liveRun: false,
    liveSession: false,
  }
  expect(decideMainStackStopGuard(idle)).toBe('stop')
  expect(decideMainStackStopGuard({ ...idle, liveRun: true })).toBe('keep')
  expect(decideMainStackStopGuard({ ...idle, liveSession: true })).toBe('keep')
  expect(decideMainStackStopGuard({ ...idle, execInProgress: true })).toBe('keep')
  expect(decideMainStackStopGuard({ ...idle, execInProgress: 'unknown' })).toBe('report')
  expect(decideMainStackStopGuard({ ...idle, servedWorktree: true })).toBe('keep')
  expect(decideMainStackStopGuard({ ...idle, servedWorktree: 'unknown' })).toBe('report')
})

test('the keep reason names the first fact the guard consulted', () => {
  const idle = {
    servedWorktree: false as boolean | 'unknown',
    execInProgress: false as boolean | 'unknown',
    liveRun: false,
    liveSession: false,
  }
  expect(mainStackStopGuardReason({ facts: { ...idle, servedWorktree: true } })).toBe(
    'a worktree of this project is served',
  )
  expect(mainStackStopGuardReason({ facts: { ...idle, execInProgress: true } })).toBe(
    'a Docker exec is in progress',
  )
  expect(mainStackStopGuardReason({ facts: { ...idle, liveRun: true } })).toBe(
    'a run is running or asking',
  )
  expect(mainStackStopGuardReason({ facts: { ...idle, liveSession: true } })).toBe(
    'an architect session is live',
  )
  expect(
    mainStackStopGuardReason({
      facts: { ...idle, servedWorktree: 'unknown' },
      servedWorktreeReason: 'docker ps exited 1',
    }),
  ).toBe('Docker could not show whether a worktree is served: docker ps exited 1')
  expect(
    mainStackStopGuardReason({
      facts: { ...idle, servedWorktree: true, execInProgress: 'unknown' },
      execInProgressReason: 'docker inspect timed out',
    }),
  ).toBe('a worktree of this project is served')
})

test('served worktree classification reads the observed containers', () => {
  const facts = {
    worktreesDirectory: '/registered/starship/.claude/worktrees',
    treeExists: (directory: string) =>
      directory === '/registered/starship/.claude/worktrees/STAR-5773',
  }
  expect(
    classifyServedWorktree({
      ...facts,
      entries: [
        { composeProject: 'starship', workingDirectory: '/registered/starship' },
        {
          composeProject: 'starship-worktree-STAR-5773',
          workingDirectory: '/registered/starship/.claude/worktrees/STAR-5773',
        },
      ],
    }),
  ).toEqual({ value: true, orphans: [] })
  expect(
    classifyServedWorktree({
      ...facts,
      entries: [{ composeProject: 'starship', workingDirectory: '/registered/starship' }],
    }),
  ).toEqual({ value: false, orphans: [] })
  expect(
    classifyServedWorktree({
      ...facts,
      entries: [
        {
          composeProject: 'starship-worktree-STAR-1',
          workingDirectory: '/registered/starship/.claude/worktrees/STAR-1',
        },
      ],
    }),
  ).toEqual({ value: false, orphans: ['starship-worktree-STAR-1'] })
  expect(
    classifyServedWorktree({
      ...facts,
      entries: [
        {
          composeProject: 'starship-worktree-STAR-1',
          workingDirectory: '/registered/starship/.claude/worktrees/STAR-1',
        },
        {
          composeProject: 'starship-worktree-STAR-5773',
          workingDirectory: '/registered/starship/.claude/worktrees/STAR-5773',
        },
      ],
    }),
  ).toEqual({ value: true, orphans: ['starship-worktree-STAR-1'] })
})

test('a declared Compose prefix counts as served only where it matches, main stack included', () => {
  const facts = {
    worktreesDirectory: '/registered/starship/.claude/worktrees',
    treeExists: () => false,
    composePrefix: 'starship_wt_',
  }
  expect(
    classifyServedWorktree({
      ...facts,
      // A served starship worktree runs compose from the main checkout, so only the
      // Compose name identifies it.
      entries: [
        { composeProject: 'starship_wt_star_5773', workingDirectory: '/elsewhere/starship' },
      ],
    }),
  ).toEqual({ value: true, orphans: [] })
  expect(
    classifyServedWorktree({
      ...facts,
      entries: [{ composeProject: 'starship', workingDirectory: '/elsewhere/starship' }],
    }),
  ).toEqual({ value: false, orphans: [] })
})

test('terminal transitions inventory only chains that recorded a worktree', () => {
  expect(
    decideTerminalDockerInventory({
      inventorySupplied: false,
      chainHasRecordedWorktree: false,
    }),
  ).toBe('skip')
  expect(
    decideTerminalDockerInventory({
      inventorySupplied: false,
      chainHasRecordedWorktree: true,
    }),
  ).toBe('take')
  expect(
    decideTerminalDockerInventory({
      inventorySupplied: true,
      chainHasRecordedWorktree: false,
    }),
  ).toBe('use-supplied')
})

test('terminal worktree resources are disposable while live and main resources are kept', () => {
  const base = {
    attributable: true,
    mainCheckout: false,
    liveRun: false,
    liveSession: false,
    terminalRun: true,
    treeAbsent: true,
  }
  expect(decideWorktreeResourceTeardown(base)).toBe('remove')
  expect(decideWorktreeResourceTeardown({ ...base, liveRun: true })).toBe('keep')
  expect(decideWorktreeResourceTeardown({ ...base, mainCheckout: true })).toBe('keep')
  expect(decideWorktreeResourceTeardown({ ...base, attributable: false })).toBe('report')
})

test('an idle main stack is stopped, never removed, while recent activity keeps it running', () => {
  const idle = {
    recordsAvailable: true,
    running: true,
    servedWorktree: false as boolean | 'unknown',
    execInProgress: false as boolean | 'unknown',
    liveRun: false,
    liveSession: false,
    lastWorktreeCreatedAtMs: 100,
    lastGateAtMs: 200,
    lastEnsureAtMs: null,
    nowMs: 1_000,
    idleStopAfterMs: 500,
  }
  expect(decideMainStackIdleStop(idle)).toBe('stop')
  expect(decideMainStackIdleStop({ ...idle, liveRun: true })).toBe('keep')
  expect(decideMainStackIdleStop({ ...idle, liveSession: true })).toBe('keep')
  expect(decideMainStackIdleStop({ ...idle, lastGateAtMs: 900 })).toBe('keep')
  expect(decideMainStackIdleStop({ ...idle, servedWorktree: true })).toBe('keep')
  expect(decideMainStackIdleStop({ ...idle, servedWorktree: 'unknown' })).toBe('report')
  expect(decideMainStackIdleStop({ ...idle, execInProgress: true })).toBe('keep')
  expect(decideMainStackIdleStop({ ...idle, execInProgress: 'unknown' })).toBe('report')
  expect(decideMainStackIdleStop({ ...idle, recordsAvailable: false })).toBe('report')
})

test('main-stack ensure decision covers declarations, service subsets, whole stacks, and unknown state', () => {
  expect(
    decideMainStackEnsure({
      consumer: 'gate',
      declaration: { consumers: ['gate'], requiredServices: ['db', 'cache'] },
      observed: { runningServices: ['db'] },
    }),
  ).toBe('start-services')
  expect(
    decideMainStackEnsure({
      consumer: 'gate',
      declaration: { consumers: ['gate'], requiredServices: ['db'] },
      observed: { runningServices: ['db'] },
    }),
  ).toBe('skip')
  expect(
    decideMainStackEnsure({ consumer: 'gate', declaration: undefined, observed: 'unknown' }),
  ).toBe('skip')
  expect(
    decideMainStackEnsure({
      consumer: 'gate',
      declaration: { consumers: ['mcp'] },
      observed: 'unknown',
    }),
  ).toBe('skip')
  expect(
    decideMainStackEnsure({
      consumer: 'gate',
      declaration: { consumers: ['gate'] },
      observed: { runningServices: [] },
    }),
  ).toBe('start-stack')
  expect(
    decideMainStackEnsure({
      consumer: 'gate',
      declaration: { consumers: ['gate'] },
      observed: { runningServices: ['web'] },
    }),
  ).toBe('skip')
  expect(
    decideMainStackEnsure({
      consumer: 'gate',
      declaration: { consumers: ['gate'] },
      observed: 'unknown',
    }),
  ).toBe('refuse')
})

test('main stack release names only services started for this consumer', () => {
  expect(
    newlyStartedMainStackServices({
      decision: 'start-services',
      before: ['pgsql'],
      requiredServices: ['pgsql', 'redis'],
    }),
  ).toEqual(['redis'])
  expect(
    newlyStartedMainStackServices({
      decision: 'start-stack',
      before: [],
      after: ['pgsql', 'redis'],
    }),
  ).toEqual(['pgsql', 'redis'])
  expect(
    newlyStartedMainStackServices({ decision: 'skip', before: ['pgsql'], after: ['pgsql'] }),
  ).toEqual([])
})

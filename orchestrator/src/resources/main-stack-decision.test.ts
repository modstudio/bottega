import { expect, test } from 'bun:test'
import {
  decideMainStackEnsure,
  decideMainStackIdleStop,
  decideTerminalDockerInventory,
  decideWorktreeResourceTeardown,
} from './main-stack-decision.ts'

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

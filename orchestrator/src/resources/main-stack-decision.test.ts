import { expect, test } from 'bun:test'
import {
  classifyMainStackState,
  decideMainStackIdleStop,
  decideMainStackStart,
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
    lastWorktreeCreatedAtMs: 100,
    lastGateAtMs: 200,
    nowMs: 1_000,
    idleStopAfterMs: 500,
  }
  expect(decideMainStackIdleStop(idle)).toBe('stop')
  expect(decideMainStackIdleStop({ ...idle, liveRun: true })).toBe('keep')
  expect(decideMainStackIdleStop({ ...idle, lastGateAtMs: 900 })).toBe('keep')
  expect(decideMainStackIdleStop({ ...idle, recordsAvailable: false })).toBe('report')
})

test('a declared consumer starts a stopped stack', () => {
  expect(
    decideMainStackStart({
      consumer: 'gate',
      declaredConsumers: ['gate'],
      stackState: 'stopped',
    }),
  ).toBe('start')
  expect(
    decideMainStackStart({
      consumer: 'gate',
      declaredConsumers: ['gate'],
      stackState: 'running',
    }),
  ).toBe('continue')
})

test('a running service keeps a stack with an exited one-shot service running', () => {
  expect(
    decideMainStackStart({
      consumer: 'gate',
      declaredConsumers: ['gate'],
      stackState: classifyMainStackState({
        containerCount: 2,
        runningContainerCount: 1,
      }),
    }),
  ).toBe('continue')
})

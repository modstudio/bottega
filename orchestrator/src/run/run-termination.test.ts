import { expect, test } from 'bun:test'
import { commandNamesRun, stoppedRunLine } from './run-termination.ts'

test('a coordinator command may name any run in the acceptable chain', () => {
  expect(commandNamesRun('bun orchestrator/src/exec.ts 41', [41, 42])).toBe(true)
  expect(commandNamesRun('bun orchestrator/src/exec.ts 41', [42, 41])).toBe(true)
  expect(commandNamesRun('bun orchestrator/src/exec.ts 43', [41, 42])).toBe(false)
  expect(commandNamesRun('bun orchestrator/src/exec.ts 410', [41])).toBe(false)
})

test('stop reports an identity mismatch with an inspect-then-signal remedy', () => {
  expect(stoppedRunLine(42, 9001, { outcome: 'identity-mismatch', acceptableIds: [41, 42] })).toBe(
    'stopped run 42; pid 9001 is present but does not name this run (expected exec.ts 41, exec.ts 42); after checking ps -p 9001 -o command, run kill -TERM 9001 only if the command shows one of those ids',
  )
})

test('stop reports an unreadable process table and an inspect-then-signal remedy', () => {
  expect(
    stoppedRunLine(42, 9001, {
      outcome: 'unascertainable',
      acceptableIds: [41, 42],
      reason: 'process inventory failed with exit 1',
    }),
  ).toBe(
    'stopped run 42; no process could be signalled because process inventory failed with exit 1; after checking ps -p 9001 -o command, run kill -TERM 9001 only if the command shows one of these ids: exec.ts 41, exec.ts 42',
  )
})

test('stop uses the plain success line for signalled, no-pid and gone outcomes', () => {
  expect(
    stoppedRunLine(42, 9001, {
      outcome: 'signalled',
      signalled: [9001],
      acceptableIds: [42],
    }),
  ).toBe('stopped run 42')
  expect(stoppedRunLine(42, null, { outcome: 'no-pid', acceptableIds: [] })).toBe('stopped run 42')
  expect(stoppedRunLine(42, 9001, { outcome: 'gone', acceptableIds: [42] })).toBe('stopped run 42')
})

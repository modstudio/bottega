import { expect, test } from 'bun:test'
import { formatOutcomeLine } from './outcome-line.ts'

test.each([
  [
    { kind: 'gate', id: 12261, exitCode: 0, signal: null, commit: 'abc123' },
    'gate 12261 passed at abc123',
  ],
  [
    { kind: 'gate', id: 12262, exitCode: 1, signal: null, commit: 'def456' },
    'gate 12262 failed (exit 1) at def456',
  ],
  [
    { kind: 'gate', id: 12263, exitCode: 0, signal: null, commit: null },
    'gate 12263 passed; commit unknown: the gate rewrote the tree',
  ],
  [
    { kind: 'gate', id: 12264, exitCode: 7, signal: null, commit: null },
    'gate 12264 failed (exit 7); commit unknown: the gate rewrote the tree',
  ],
  [{ kind: 'exec', id: 21, exitCode: 0, signal: null }, 'exec 21 passed'],
  [{ kind: 'exec', id: 22, exitCode: 9, signal: null }, 'exec 22 failed (exit 9)'],
  [{ kind: 'exec', id: 23, exitCode: -1, signal: 'SIGTERM' }, 'exec 23 killed by SIGTERM'],
  [{ kind: 'probe', id: 31, exitCode: 0, signal: null }, 'probe 31 passed'],
  [{ kind: 'probe', id: 32, exitCode: 2, signal: null }, 'probe 32 failed (exit 2)'],
  [{ kind: 'probe', id: 33, exitCode: -1, signal: 'SIGKILL' }, 'probe 33 killed by SIGKILL'],
] as const)('formats the ruled outcome line for %#', (input, expected) => {
  expect(formatOutcomeLine(input)).toBe(expected)
})

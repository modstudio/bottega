import { expect, test } from 'bun:test'
import { parseProcessTable, processInventorySubprocessError } from './process-inventory.ts'

test('classifies process inventory subprocess failures', () => {
  expect(
    processInventorySubprocessError('ps', 10_000, {
      exitCode: 0,
      signalCode: null,
      exitedDueToTimeout: false,
      stderr: '',
    }),
  ).toBeNull()
  expect(
    processInventorySubprocessError('lsof', 10_000, {
      exitCode: null,
      signalCode: 'SIGTERM',
      exitedDueToTimeout: true,
      stderr: '',
    }),
  ).toBe('lsof timed out after 10000 ms')
  expect(
    processInventorySubprocessError('lsof', 10_000, {
      exitCode: null,
      signalCode: 'SIGKILL',
      exitedDueToTimeout: false,
      stderr: '',
    }),
  ).toBe('lsof ended on signal SIGKILL')
  expect(
    processInventorySubprocessError('lsof', 10_000, {
      exitCode: 7,
      signalCode: null,
      exitedDueToTimeout: false,
      stderr: 'permission denied',
    }),
  ).toBe('lsof exited 7: permission denied')
})

test('parses faithful macOS ps etime output', () => {
  expect(parseProcessTable('  91     1    91  2-03:04:05 /usr/bin/node vite --host\n')).toEqual([
    {
      pid: 91,
      ppid: 1,
      pgid: 91,
      ageSeconds: 183_845,
      command: '/usr/bin/node vite --host',
      cwd: null,
    },
  ])
})

test('parses faithful Linux ps etime output and ignores malformed age', () => {
  expect(
    parseProcessTable('  27  1  27  04:05:06 docker compose up\n  28  1  28 bad nope\n'),
  ).toEqual([
    {
      pid: 27,
      ppid: 1,
      pgid: 27,
      ageSeconds: 14_706,
      command: 'docker compose up',
      cwd: null,
    },
  ])
})

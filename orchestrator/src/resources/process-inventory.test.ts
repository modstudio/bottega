import { expect, test } from 'bun:test'
import { processObservationError } from '../../../shared/process-identity.ts'
import {
  ancestorChain,
  joinProcessCwd,
  parseProcessTable,
  sessionAnchors,
} from './process-inventory.ts'

test('classifies process inventory subprocess failures', () => {
  expect(
    processObservationError('ps', 10_000, {
      exitCode: 0,
      signalCode: null,
      exitedDueToTimeout: false,
      stderr: '',
    }),
  ).toBeNull()
  expect(
    processObservationError('lsof', 10_000, {
      exitCode: null,
      signalCode: 'SIGTERM',
      exitedDueToTimeout: true,
      stderr: '',
    }),
  ).toBe('lsof timed out after 10000 ms')
  expect(
    processObservationError('lsof', 10_000, {
      exitCode: null,
      signalCode: 'SIGKILL',
      exitedDueToTimeout: false,
      stderr: '',
    }),
  ).toBe('lsof ended on signal SIGKILL')
  expect(
    processObservationError('lsof', 10_000, {
      exitCode: 7,
      signalCode: null,
      exitedDueToTimeout: false,
      stderr: 'permission denied',
    }),
  ).toBe('lsof exited 7: permission denied')
})

test('parses faithful macOS ps etime output', () => {
  expect(
    parseProcessTable(
      '  91     1    91 42.5 Mon Oct 20 12:34:56 2026  2-03:04:05 /usr/bin/node vite --host\n',
    ),
  ).toEqual([
    {
      pid: 91,
      ppid: 1,
      pgid: 91,
      cpu: 42.5,
      ageSeconds: 183_845,
      startTime: 'Mon Oct 20 12:34:56 2026',
      command: '/usr/bin/node vite --host',
      cwd: null,
      cwdVerified: false,
    },
  ])
})

test('parses faithful Linux ps etime output and ignores malformed age', () => {
  expect(
    parseProcessTable(
      '  27  1  27 8.0 Tue Oct 21 01:02:03 2026  04:05:06 docker compose up\n  28  1  28 bad nope\n',
    ),
  ).toEqual([
    {
      pid: 27,
      ppid: 1,
      pgid: 27,
      cpu: 8,
      ageSeconds: 14_706,
      startTime: 'Tue Oct 21 01:02:03 2026',
      command: 'docker compose up',
      cwd: null,
      cwdVerified: false,
    },
  ])
})

test('sessions under one terminal receive distinct harness anchors', () => {
  const anchors = sessionAnchors([
    { sessionId: 'one', chain: [101, 50, 20, 1] },
    { sessionId: 'two', chain: [102, 50, 20, 1] },
  ])
  expect(anchors).toEqual(
    new Map([
      ['one', 101],
      ['two', 102],
    ]),
  )
  expect([...anchors.values()]).not.toContain(50)
})

test('ancestor chains stop at pid 1 and at a missing parent', () => {
  const processes = [
    { pid: 1, ppid: 0, cpu: 0, command: 'init' },
    { pid: 10, ppid: 1, cpu: 0, command: 'terminal' },
    { pid: 11, ppid: 10, cpu: 0, command: 'cli' },
    { pid: 20, ppid: 19, cpu: 0, command: 'detached' },
  ]
  expect(ancestorChain(11, processes)).toEqual([10, 1])
  expect(ancestorChain(20, processes)).toEqual([19])
})

test('marks a cwd verified only when the process birth still matches the ps snapshot', () => {
  expect(joinProcessCwd('/tmp/tree', 'birth-a', 'birth-a')).toEqual({
    cwd: '/tmp/tree',
    cwdVerified: true,
  })
  expect(joinProcessCwd('/tmp/tree', 'birth-a', 'birth-b')).toEqual({
    cwd: '/tmp/tree',
    cwdVerified: false,
  })
  expect(joinProcessCwd('/tmp/tree', 'birth-a', null)).toEqual({
    cwd: '/tmp/tree',
    cwdVerified: false,
  })
})

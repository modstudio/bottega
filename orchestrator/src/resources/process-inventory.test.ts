import { expect, test } from 'bun:test'
import { processObservationError } from '../../../shared/process-identity.ts'
import {
  ancestorChain,
  ancestorIdentityChain,
  commonAncestorChain,
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
    {
      sessionId: 'one',
      chain: [101, 50, 20, 1].map((pid) => ({ pid, startTime: `birth-${pid}` })),
    },
    {
      sessionId: 'two',
      chain: [102, 50, 20, 1].map((pid) => ({ pid, startTime: `birth-${pid}` })),
    },
  ])
  expect(anchors).toEqual(
    new Map([
      ['one', { pid: 101, startTime: 'birth-101' }],
      ['two', { pid: 102, startTime: 'birth-102' }],
    ]),
  )
  expect([...anchors.values()].map(({ pid }) => pid)).not.toContain(50)
})

test('a single session anchors at its nearest ancestor, never pid 1 or the terminal', () => {
  const anchors = sessionAnchors([
    {
      sessionId: 'solo',
      chain: [400, 300, 1].map((pid) => ({ pid, startTime: `birth-${pid}` })),
    },
  ])
  expect(anchors.get('solo')).toEqual({ pid: 400, startTime: 'birth-400' })
})

test('differing shells converge on the deepest common ancestor', () => {
  const identity = (pid: number) => ({ pid, startTime: `birth-${pid}` })
  expect(
    commonAncestorChain(
      [identity(501), identity(400), identity(300), identity(1)],
      [identity(502), identity(400), identity(300), identity(1)],
    ),
  ).toEqual([identity(400), identity(300), identity(1)])
})

test('an anchor shared with another live session is rejected for both', () => {
  const chain = [
    { pid: 400, startTime: 'harness' },
    { pid: 300, startTime: 'terminal' },
    { pid: 1, startTime: 'init' },
  ]
  expect(
    sessionAnchors([
      { sessionId: 'one', chain },
      { sessionId: 'two', chain },
    ]),
  ).toEqual(new Map())
})

test('ancestor chains stop at pid 1 and at a missing parent', () => {
  const processes = [
    { pid: 1, ppid: 0, cpu: 0, command: 'init', startTime: 'one' },
    { pid: 10, ppid: 1, cpu: 0, command: 'terminal', startTime: 'ten' },
    { pid: 11, ppid: 10, cpu: 0, command: 'cli', startTime: 'eleven' },
    { pid: 20, ppid: 19, cpu: 0, command: 'detached', startTime: 'twenty' },
  ]
  expect(ancestorChain(11, processes)).toEqual([10, 1])
  expect(ancestorChain(20, processes)).toEqual([19])
  expect(ancestorIdentityChain(11, processes)).toEqual([
    { pid: 10, startTime: 'ten' },
    { pid: 1, startTime: 'one' },
  ])
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

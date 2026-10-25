import { expect, test } from 'bun:test'
import { processObservationError } from '../../../shared/process-identity.ts'
import {
  environmentCarriesRunMarker,
  joinProcessCwd,
  joinRunMarker,
  type OrphanCandidate,
  parseProcessEnvironmentEvidence,
  parseProcessTable,
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

test('reads a run marker from either environment shape and never from a value', () => {
  expect(environmentCarriesRunMarker('PATH=/bin\0BOTTEGA_DEPTH=1\0HOME=/Users/x')).toBe(true)
  expect(environmentCarriesRunMarker('PATH=/bin\0BOTTEGA_RUN_PROCESS=1')).toBe(true)
  expect(environmentCarriesRunMarker('PATH=/bin HOME=/Users/x')).toBe(false)
  // A marker name with no value, and one spelled inside another variable's value,
  // are not ownership evidence.
  expect(environmentCarriesRunMarker('BOTTEGA_DEPTH=')).toBe(false)
  expect(environmentCarriesRunMarker('FOO=BOTTEGA_DEPTH=1')).toBe(false)
  expect(environmentCarriesRunMarker('BOTTEGA_DEPTHISH=1')).toBe(false)
})

test('separates a ps environment from the command it is printed after', () => {
  const commands = new Map([
    [91, '/usr/bin/node vite --host'],
    [92, '/usr/bin/node vite --host'],
    [93, '/usr/bin/node vite --host'],
    [95, 'BOTTEGA_DEPTH=1 node vite'],
  ])
  const evidence = parseProcessEnvironmentEvidence(
    [
      '  91 /usr/bin/node vite --host PATH=/bin BOTTEGA_DEPTH=2',
      '  92 /usr/bin/node vite --host PATH=/bin HOME=/Users/x',
      '  93 /usr/bin/node vite --host',
      '  94 /usr/bin/node BOTTEGA_RUN_PROCESS=1',
      '  95 BOTTEGA_DEPTH=1 node vite',
      '  not a process line',
    ].join('\n'),
    commands,
    92,
  )
  expect(evidence.get(91)).toBe('present')
  expect(evidence.get(92)).toBe('absent')
  // ps printing no environment for a process the parser did report is absent.
  expect(evidence.get(93)).toBe('absent')
  // A pid whose command does not precede the text cannot be separated, and a
  // probe that cannot be separated proves nothing about the platform.
  const unseparated = parseProcessEnvironmentEvidence(
    ['  94 /usr/bin/node BOTTEGA_RUN_PROCESS=1', '  92 /usr/bin/node vite --host PATH=/bin'].join(
      '\n',
    ),
    commands,
    94,
  )
  expect(unseparated.get(94)).toBe('unknown')
  expect(unseparated.get(92)).toBe('unknown')
  // A marker spelled in the command line itself is not an environment read.
  expect(evidence.get(95)).toBe('absent')
})

test('a ps that prints no environment at all makes every candidate unknown', () => {
  const probePid = 4242
  const commands = new Map([
    [91, '/usr/bin/node vite --host'],
    [probePid, 'bun check'],
  ])
  // The probe process always carries PATH, so a line with no entry after its
  // command means this ps cannot read environments: nothing proves absence.
  const unreadable = parseProcessEnvironmentEvidence(
    ['  91 /usr/bin/node vite --host BOTTEGA_DEPTH=1', `  ${probePid} bun check`].join('\n'),
    commands,
    probePid,
  )
  expect(unreadable.get(91)).toBe('unknown')
  expect(unreadable.get(probePid)).toBe('unknown')
  // A probe line that does print an environment leaves the candidates as read.
  const readable = parseProcessEnvironmentEvidence(
    [
      '  91 /usr/bin/node vite --host PATH=/bin BOTTEGA_DEPTH=1',
      `  ${probePid} bun check PATH=/usr/bin:/bin HOME=/Users/operator`,
    ].join('\n'),
    commands,
    probePid,
  )
  expect(readable.get(91)).toBe('present')
  expect(readable.get(probePid)).toBe('absent')
  // A probe line ps did not print at all cannot be trusted either.
  expect(
    parseProcessEnvironmentEvidence(
      '  91 /usr/bin/node vite --host PATH=/bin',
      commands,
      probePid,
    ).get(91),
  ).toBe('unknown')
})

test('an environment that was not read stays unknown on the inventory row', () => {
  const candidate: OrphanCandidate = {
    pid: 42,
    ppid: 1,
    pgid: 42,
    cpu: 0,
    command: 'vite',
    ageSeconds: 5,
    startTime: 'birth',
    cwd: '/trees/gone',
    cwdVerified: true,
    missingTree: '/trees/gone',
    project: 'app',
    match: 'cwd',
  }
  expect(joinRunMarker([candidate], new Map([[42, 'present']]))).toEqual([
    { ...candidate, runMarker: 'present' },
  ])
  expect(joinRunMarker([candidate], new Map())[0]!.runMarker).toBe('unknown')
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

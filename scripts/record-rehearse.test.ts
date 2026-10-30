import { expect, test } from 'bun:test'
import {
  launchedMachineId,
  machineExitCode,
  parseRehearsalLines,
  type RehearsalCommandRunner,
  rehearsalStatus,
  runRecordRehearsal,
} from './record-rehearse.ts'

const hash = 'a'.repeat(64)
const passOutput = `REHEARSAL DUMP record/new.dump
REHEARSAL PENDING 1
REHEARSAL RESTORE 123
REHEARSAL MIGRATE 45
REHEARSAL PASS ${hash}`

test('parses contract lines and classifies a pass', () => {
  const prefixed = passOutput
    .split('\n')
    .map((line) => `2026-10-30T10:00:00Z app[id] ewr [info] ${line}`)
    .join('\n')
  const lines = parseRehearsalLines(`postgres noise\n${prefixed}\nmore noise`)
  expect(lines).toEqual({
    dump: 'record/new.dump',
    pending: 1,
    restoreMs: 123,
    migrateMs: 45,
    hash,
  })
  expect(rehearsalStatus(lines, 0)).toEqual({
    state: 'success',
    description: `migration-set ${hash}; restore 123; migrate 45; dump record/new.dump`,
  })
})

test('classifies a failed machine and bounds the GitHub description', () => {
  const lines = parseRehearsalLines(`REHEARSAL FAIL ${'x'.repeat(200)}`)
  const status = rehearsalStatus(lines, 1)
  expect(status.state).toBe('failure')
  expect(status.description).toStartWith('REHEARSAL FAIL ')
  expect(status.description.length).toBe(140)
})

test('reads the exit event from machine details', () => {
  expect(
    machineExitCode({ events: [{ request: {} }, { request: { exit_event: { exit_code: 7 } } }] }),
  ).toBe(7)
})

test('reads the launched machine id from flyctl output', () => {
  expect(launchedMachineId('Success!\nMachine ID: 148ed467a53189\nState: started')).toBe(
    '148ed467a53189',
  )
})

test('runs, posts success and destroys the machine through the injected runner', async () => {
  const calls: string[][] = []
  const runner: RehearsalCommandRunner = async (argv) => {
    calls.push([...argv])
    if (argv[0] === 'git' && argv[1] === 'rev-parse')
      return { exitCode: 0, stdout: 'deadbeef\n', stderr: '' }
    if (argv[0] === 'flyctl' && argv[1] === 'machine' && argv[2] === 'run')
      return { exitCode: 0, stdout: 'Machine ID: abcdef12345678\n', stderr: '' }
    if (argv[0] === 'flyctl' && argv[1] === 'logs')
      return { exitCode: 0, stdout: passOutput, stderr: '' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  await expect(
    runRecordRehearsal({
      token: 'sealed-token',
      runner,
      machineDetails: async () => ({ events: [{ request: { exit_event: { exit_code: 0 } } }] }),
    }),
  ).resolves.toMatchObject({ hash })
  expect(
    calls.some(
      (argv) => argv.includes('context=record-rehearsal') && argv.includes('state=success'),
    ),
  ).toBe(true)
  expect(calls.at(-1)?.slice(0, 3)).toEqual(['flyctl', 'machine', 'destroy'])
})

test('refuses a dirty tree before starting a machine', async () => {
  const runner: RehearsalCommandRunner = async () => ({
    exitCode: 0,
    stdout: ' M scripts/record-rehearse.ts\n',
    stderr: '',
  })
  await expect(
    runRecordRehearsal({
      token: 'sealed-token',
      runner,
      machineDetails: async () => ({}),
    }),
  ).rejects.toThrow('dirty working tree')
})

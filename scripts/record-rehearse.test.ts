import { expect, spyOn, test } from 'bun:test'
import {
  launchedMachineId,
  machineExitCode,
  parseRehearsalLines,
  type RehearsalCommandRunner,
  rehearsalStatus,
  rerunFailedRecordRehearsal,
  runRecordRehearsal,
} from './record-rehearse.ts'

const hash = 'a'.repeat(64)
const passOutput = `REHEARSAL DUMP record/new.dump
REHEARSAL PENDING 1
REHEARSAL RESTORE 123
REHEARSAL MIGRATE 45
REHEARSAL PASS ${hash}`

function gitResult(argv: readonly string[]) {
  if (argv[0] !== 'git') return undefined
  if (argv[1] === 'status') return { exitCode: 0, stdout: '', stderr: '' }
  if (argv[1] === 'rev-parse') return { exitCode: 0, stdout: 'deadbeef\n', stderr: '' }
  if (argv[1] === 'branch' && argv[2] === '--show-current')
    return { exitCode: 0, stdout: 'DEV-1896-test\n', stderr: '' }
  if (argv[1] === 'branch' && argv[2] === '--remotes')
    return { exitCode: 0, stdout: '  origin/DEV-1896-test\n', stderr: '' }
  return undefined
}

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
    description: `migration-set ${hash}; pending 1; restore 123; migrate 45; dump record/new.dump`,
  })
})

test('destroys a launched machine when waiting for it fails', async () => {
  const calls: string[][] = []
  const runner: RehearsalCommandRunner = async (argv) => {
    calls.push([...argv])
    const git = gitResult(argv)
    if (git) return git
    if (argv[0] === 'flyctl' && argv[2] === 'run')
      return { exitCode: 0, stdout: 'Machine ID: abcdef12345678\n', stderr: '' }
    if (argv[0] === 'flyctl' && argv[2] === 'wait')
      return { exitCode: 124, stdout: '', stderr: 'timed out' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }

  await expect(
    runRecordRehearsal({
      token: 'sealed-token',
      runner,
      machineDetails: async () => ({}),
    }),
  ).rejects.toThrow('timed out')
  expect(calls.at(-1)).toContain('abcdef12345678')
  expect(calls.at(-1)?.slice(0, 3)).toEqual(['flyctl', 'machine', 'destroy'])
})

test('finds a named machine and destroys it when launch output has no id', async () => {
  const calls: string[][] = []
  let launchedName = ''
  const runner: RehearsalCommandRunner = async (argv) => {
    calls.push([...argv])
    const git = gitResult(argv)
    if (git) return git
    if (argv[0] === 'flyctl' && argv[2] === 'run') {
      launchedName = argv[argv.indexOf('--name') + 1]!
      return { exitCode: 0, stdout: 'started\n', stderr: '' }
    }
    if (argv[0] === 'flyctl' && argv[2] === 'list') {
      return {
        exitCode: 0,
        stdout: JSON.stringify([{ id: 'abcdef12345678', name: launchedName }]),
        stderr: '',
      }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }

  await expect(
    runRecordRehearsal({
      token: 'sealed-token',
      runner,
      machineDetails: async () => ({}),
    }),
  ).rejects.toThrow(launchedName)
  expect(calls.some((argv) => argv.slice(0, 3).join(' ') === 'flyctl machine list')).toBe(true)
  expect(calls.at(-1)).toContain('abcdef12345678')
  expect(calls.at(-1)?.slice(0, 3)).toEqual(['flyctl', 'machine', 'destroy'])
})

test('classifies a failed machine and bounds the GitHub description', () => {
  const lines = parseRehearsalLines(`REHEARSAL FAIL ${'x'.repeat(200)}`)
  const status = rehearsalStatus(lines, 1)
  expect(status.state).toBe('failure')
  expect(status.description).toStartWith('REHEARSAL FAIL ')
  expect(status.description.length).toBe(140)
})

test('refuses a pass that applied no pending migration', () => {
  const lines = parseRehearsalLines(
    passOutput.replace('REHEARSAL PENDING 1', 'REHEARSAL PENDING 0'),
  )
  expect(rehearsalStatus(lines, 0)).toEqual({
    state: 'failure',
    description: 'REHEARSAL FAIL machine exit 0 without a valid PASS',
  })
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
    const git = gitResult(argv)
    if (git) return git
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

test('reruns only the unsuccessful record-rehearsal job on an open pull request', async () => {
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    for (const conclusion of ['failure', 'cancelled', 'timed_out']) {
      const calls: string[][] = []
      const runner: RehearsalCommandRunner = async (argv) => {
        calls.push([...argv])
        if (argv.includes('repos/{owner}/{repo}/pulls?state=open&per_page=100')) {
          return { exitCode: 0, stdout: '1931\n', stderr: '' }
        }
        if (argv.includes('repos/{owner}/{repo}/commits/deadbeef/check-runs')) {
          return {
            exitCode: 0,
            stdout: `7788\t${conclusion}\thttps://github.com/example/repo/actions/runs/5566/job/7788\n`,
            stderr: '',
          }
        }
        return { exitCode: 0, stdout: 'rerun requested\n', stderr: '' }
      }

      await rerunFailedRecordRehearsal(runner, 'deadbeef')

      expect(calls.filter((argv) => argv.slice(0, 3).join(' ') === 'gh run rerun')).toEqual([
        ['gh', 'run', 'rerun', '5566', '--job', '7788'],
      ])
      expect(calls.flat()).not.toContain('--failed')
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`after ${conclusion}`))
    }
  } finally {
    log.mockRestore()
  }
})

test('does not rerun a successful record-rehearsal job', async () => {
  const calls: string[][] = []
  const runner: RehearsalCommandRunner = async (argv) => {
    calls.push([...argv])
    if (argv.includes('repos/{owner}/{repo}/pulls?state=open&per_page=100'))
      return { exitCode: 0, stdout: '1931\n', stderr: '' }
    if (argv.includes('repos/{owner}/{repo}/commits/deadbeef/check-runs')) {
      return {
        exitCode: 0,
        stdout: '7788\tsuccess\thttps://github.com/example/repo/actions/runs/5566/job/7788\n',
        stderr: '',
      }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }

  await rerunFailedRecordRehearsal(runner, 'deadbeef')

  expect(calls.some((argv) => argv.slice(0, 3).join(' ') === 'gh run rerun')).toBe(false)
})

test('keeps a passed rehearsal when the rerun request fails', async () => {
  const error = spyOn(console, 'error').mockImplementation(() => {})
  const runner: RehearsalCommandRunner = async (argv) => {
    const git = gitResult(argv)
    if (git) return git
    if (argv[0] === 'flyctl' && argv[1] === 'machine' && argv[2] === 'run')
      return { exitCode: 0, stdout: 'Machine ID: abcdef12345678\n', stderr: '' }
    if (argv[0] === 'flyctl' && argv[1] === 'logs')
      return { exitCode: 0, stdout: passOutput, stderr: '' }
    if (argv.includes('repos/{owner}/{repo}/pulls?state=open&per_page=100'))
      return { exitCode: 0, stdout: '1931\n', stderr: '' }
    if (argv.includes('repos/{owner}/{repo}/commits/deadbeef/check-runs')) {
      return {
        exitCode: 0,
        stdout: '7788\tfailure\thttps://github.com/example/repo/actions/runs/5566/job/7788\n',
        stderr: '',
      }
    }
    if (argv.slice(0, 3).join(' ') === 'gh run rerun')
      return { exitCode: 1, stdout: '', stderr: 'permission denied' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }

  try {
    await expect(
      runRecordRehearsal({
        token: 'sealed-token',
        runner,
        machineDetails: async () => ({ events: [{ request: { exit_event: { exit_code: 0 } } }] }),
      }),
    ).resolves.toMatchObject({ hash, pending: 1 })
    expect(error).toHaveBeenCalledWith(
      'record rehearsal passed; rerun request failed: gh run rerun 5566 --job 7788 failed: permission denied; rerun it with gh run rerun 5566 --job 7788',
    )
  } finally {
    error.mockRestore()
  }
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

test('retries Fly deadline_exceeded waits until the machine stops', async () => {
  const calls: string[][] = []
  let waits = 0
  const runner: RehearsalCommandRunner = async (argv) => {
    calls.push([...argv])
    const git = gitResult(argv)
    if (git) return git
    if (argv[0] === 'flyctl' && argv[2] === 'run')
      return { exitCode: 0, stdout: 'Machine ID: abcdef12345678\n', stderr: '' }
    if (argv[0] === 'flyctl' && argv[2] === 'wait') {
      waits += 1
      if (waits < 3) return { exitCode: 1, stdout: '', stderr: 'rpc error: deadline_exceeded' }
    }
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
  expect(waits).toBe(3)
  expect(
    calls
      .filter((argv) => argv[0] === 'flyctl' && argv[2] === 'wait')
      .every((argv) => argv.includes('60s')),
  ).toBe(true)
})

test('fails immediately on a non-deadline wait error', async () => {
  let waits = 0
  const runner: RehearsalCommandRunner = async (argv) => {
    const git = gitResult(argv)
    if (git) return git
    if (argv[0] === 'flyctl' && argv[2] === 'run')
      return { exitCode: 0, stdout: 'Machine ID: abcdef12345678\n', stderr: '' }
    if (argv[0] === 'flyctl' && argv[2] === 'wait') {
      waits += 1
      return { exitCode: 1, stdout: '', stderr: 'permission denied' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }

  await expect(
    runRecordRehearsal({
      token: 'sealed-token',
      runner,
      machineDetails: async () => ({}),
    }),
  ).rejects.toThrow('permission denied')
  expect(waits).toBe(1)
})

test('refuses an unpushed HEAD before starting a machine', async () => {
  const calls: string[][] = []
  const runner: RehearsalCommandRunner = async (argv) => {
    calls.push([...argv])
    const git = gitResult(argv)
    if (argv[0] === 'git' && argv[1] === 'branch' && argv[2] === '--remotes')
      return { exitCode: 0, stdout: '  upstream/DEV-1896-test\n', stderr: '' }
    if (git) return git
    return { exitCode: 0, stdout: '', stderr: '' }
  }

  await expect(
    runRecordRehearsal({
      token: 'sealed-token',
      runner,
      machineDetails: async () => ({}),
    }),
  ).rejects.toThrow('git push -u origin DEV-1896-test')
  expect(calls.some((argv) => argv[0] === 'flyctl' && argv[2] === 'run')).toBe(false)
})

test('preserves the original wait error when posting failure status also fails', async () => {
  const originalWaitError = `wait failed with ${'full detail '.repeat(20)}`
  const runner: RehearsalCommandRunner = async (argv) => {
    const git = gitResult(argv)
    if (git) return git
    if (argv[0] === 'flyctl' && argv[2] === 'run')
      return { exitCode: 0, stdout: 'Machine ID: abcdef12345678\n', stderr: '' }
    if (argv[0] === 'flyctl' && argv[2] === 'wait')
      return { exitCode: 1, stdout: '', stderr: originalWaitError }
    if (argv[0] === 'gh') return { exitCode: 1, stdout: '', stderr: 'No commit found for SHA' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }

  const rehearsal = runRecordRehearsal({
    token: 'sealed-token',
    runner,
    machineDetails: async () => ({}),
  })
  await expect(rehearsal).rejects.toThrow(originalWaitError.trim())
  await expect(rehearsal).rejects.toThrow('status post failed:')
})

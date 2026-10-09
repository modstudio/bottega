import { describe, expect, test } from 'bun:test'
import { decideGitleaksScan, planGitleaksScans } from './check-gitleaks-plan'

const input = {
  range: 'landing..HEAD',
  repository: '/repo/',
  config: '/repo/.gitleaks.toml',
}

describe('gitleaks scan plan', () => {
  test('scans branch history when the branch has commits', () => {
    expect(planGitleaksScans({ ...input, rangeCommitCount: 2 })).toEqual([
      {
        mode: 'history',
        args: [
          'git',
          '/repo/',
          '--config',
          '/repo/.gitleaks.toml',
          '--redact',
          '--exit-code',
          '1',
          '--log-opts=landing..HEAD',
        ],
      },
    ])
  })

  test('scans only staged and working-tree changes when the branch has no commits', () => {
    expect(planGitleaksScans({ ...input, rangeCommitCount: 0 })).toEqual([
      {
        mode: 'staged',
        args: [
          'git',
          '/repo/',
          '--config',
          '/repo/.gitleaks.toml',
          '--redact',
          '--exit-code',
          '1',
          '--pre-commit',
          '--staged',
        ],
      },
      {
        mode: 'working-tree',
        args: [
          'git',
          '/repo/',
          '--config',
          '/repo/.gitleaks.toml',
          '--redact',
          '--exit-code',
          '1',
          '--pre-commit',
        ],
      },
    ])
  })
})

describe('gitleaks scan decision', () => {
  test('passes a clean history scan with the expected colored commit count', () => {
    expect(
      decideGitleaksScan({
        mode: 'history',
        expectedCommitCount: 2,
        exitCode: 0,
        log: '\x1b[90m12:00PM\x1b[0m \x1b[32mINF\x1b[0m \x1b[1m2 commits scanned.\x1b[0m',
      }),
    ).toEqual({ status: 'pass' })
  })

  test('refuses the reproduced colored error and zero-commit history log', () => {
    const decision = decideGitleaksScan({
      mode: 'history',
      expectedCommitCount: 1,
      exitCode: 0,
      log: [
        '\x1b[90m12:00PM\x1b[0m \x1b[31mERR\x1b[0m error="stderr is not empty"',
        '\x1b[90m12:00PM\x1b[0m \x1b[32mINF\x1b[0m 0 commits scanned.',
        'INF scanned ~0 bytes (0)',
        'INF no leaks found',
      ].join('\n'),
    })

    expect(decision).toEqual({
      status: 'refused',
      message:
        'expected no error-level log line; gitleaks reported: 12:00PM ERR error="stderr is not empty". expected between 1 and 1 commits scanned; gitleaks reported 0. Run the printed gitleaks command directly. Clear whatever makes git write to stderr.',
    })
  })

  test('passes a lower nonzero history count', () => {
    expect(
      decideGitleaksScan({
        mode: 'history',
        expectedCommitCount: 3,
        exitCode: 0,
        log: 'INF 2 commits scanned.\nINF no leaks found',
      }),
    ).toEqual({ status: 'pass' })
  })

  test('refuses a zero history count', () => {
    expect(
      decideGitleaksScan({
        mode: 'history',
        expectedCommitCount: 3,
        exitCode: 0,
        log: 'INF 0 commits scanned.\nINF no leaks found',
      }),
    ).toEqual({
      status: 'refused',
      message:
        'expected between 1 and 3 commits scanned; gitleaks reported 0. Run the printed gitleaks command directly. Clear whatever makes git write to stderr.',
    })
  })

  test('refuses a history count above expected', () => {
    expect(
      decideGitleaksScan({
        mode: 'history',
        expectedCommitCount: 3,
        exitCode: 0,
        log: 'INF 4 commits scanned.\nINF no leaks found',
      }),
    ).toEqual({
      status: 'refused',
      message:
        'expected between 1 and 3 commits scanned; gitleaks reported 4. Run the printed gitleaks command directly. Clear whatever makes git write to stderr.',
    })
  })

  test('refuses a history log without a commits-scanned line', () => {
    expect(
      decideGitleaksScan({
        mode: 'history',
        expectedCommitCount: 1,
        exitCode: 0,
        log: 'INF no leaks found',
      }),
    ).toEqual({
      status: 'refused',
      message:
        'expected between 1 and 1 commits scanned; gitleaks reported no commits-scanned line. Run the printed gitleaks command directly. Clear whatever makes git write to stderr.',
    })
  })

  test('refuses a working-tree scan with an error line', () => {
    expect(
      decideGitleaksScan({
        mode: 'working-tree',
        exitCode: 0,
        log: 'ERR error="stderr is not empty"',
      }),
    ).toEqual({
      status: 'refused',
      message:
        'expected no error-level log line; gitleaks reported: ERR error="stderr is not empty". Run the printed gitleaks command directly. Clear whatever makes git write to stderr.',
    })
  })

  test('passes a working-tree scan without an error line', () => {
    expect(
      decideGitleaksScan({
        mode: 'working-tree',
        exitCode: 0,
        log: 'INF scanned ~12 bytes (12 bytes)\nINF no leaks found',
      }),
    ).toEqual({ status: 'pass' })
  })

  test('refuses a nonzero exit code', () => {
    expect(
      decideGitleaksScan({
        mode: 'working-tree',
        exitCode: 1,
        log: 'WRN leaks found: 1',
      }),
    ).toEqual({
      status: 'refused',
      message:
        'expected exit code 0; gitleaks reported exit code 1. Gitleaks reported leaks or failed; see its output above and run the printed gitleaks command directly.',
    })
  })
})

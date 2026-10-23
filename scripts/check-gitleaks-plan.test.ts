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
  test('passes a clean scan with an xcrun cache warning', () => {
    expect(
      decideGitleaksScan({
        exitCode: 0,
        log: [
          "git: error: couldn't create cache file '/var/folders/run/T/xcrun_db-abc' (errno=Operation not permitted)",
          '12:00PM ERR error="stderr is not empty"',
          '12:00PM INF 0 commits scanned.',
          '12:00PM INF no leaks found',
        ].join('\n'),
      }),
    ).toEqual({ status: 'pass' })
  })

  test('refuses an unrelated error-level line from an exit-zero scan', () => {
    expect(
      decideGitleaksScan({
        exitCode: 0,
        log: '12:00PM ERR failed to enumerate git objects',
      }),
    ).toEqual({
      status: 'refused',
      message:
        'gitleaks reported an error-level log line: 12:00PM ERR failed to enumerate git objects. See its output above and run the printed gitleaks command directly.',
    })
  })

  test('refuses a reported leak', () => {
    expect(
      decideGitleaksScan({
        exitCode: 1,
        log: '\x1b[33m12:00PM WRN leaks found: 1\x1b[0m',
      }),
    ).toEqual({
      status: 'refused',
      message:
        'gitleaks reported leaks: 12:00PM WRN leaks found: 1. Remove the reported secrets and run the printed gitleaks command directly.',
    })
  })

  test('refuses a scanner error', () => {
    expect(
      decideGitleaksScan({
        exitCode: 1,
        log: '12:00PM ERR failed to load config',
      }),
    ).toEqual({
      status: 'refused',
      message:
        'gitleaks scanner failed with exit code 1; see its output above and run the printed gitleaks command directly.',
    })
  })
})

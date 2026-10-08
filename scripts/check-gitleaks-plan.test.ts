import { describe, expect, test } from 'bun:test'
import { planGitleaksScans } from './check-gitleaks-plan'

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

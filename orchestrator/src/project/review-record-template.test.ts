import { expect, test } from 'bun:test'
import { reviewRecordArgv } from './review-record-template.ts'

test('builds argv without shell interpolation when a substituted reason contains shell syntax', () => {
  const reason = `correctness and craft accepted; keep "quoted" evidence`
  expect(
    reviewRecordArgv(
      `project-review record --tier {tier} --reason "{reason}" --agents {agents} --findings '{findings}' --branch {branch}`,
      {
        tier: '2',
        reason,
        agents: '3',
        findings: '/state/review findings.json',
        branch: 'DEV-1110-review-record',
      },
    ),
  ).toEqual([
    'project-review',
    'record',
    '--tier',
    '2',
    '--reason',
    reason,
    '--agents',
    '3',
    '--findings',
    '/state/review findings.json',
    '--branch',
    'DEV-1110-review-record',
  ])
})

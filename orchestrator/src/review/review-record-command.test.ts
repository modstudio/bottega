import { expect, test } from 'bun:test'
import type { ReviewRecordCommandOperations } from './review-record-command.ts'
import { recordProjectReviewCommand } from './review-record-command.ts'
import type { ReviewRecordFindingsFile } from './review-record-findings.ts'

function operations(
  overrides: Partial<ReviewRecordCommandOperations> = {},
): ReviewRecordCommandOperations {
  return {
    project: () => ({
      name: 'fixture',
      settings: {
        review: {
          lenses: [{ lens: 'correctness' }],
          record:
            'project-review record --tier {tier} --reason "{reason}" --agents {agents} --findings {findings} --branch {branch}',
        },
      },
    }),
    review: () => ({
      complete: true,
      tier: 2,
      rows: [
        {
          lens: 'correctness',
          run: 71,
          disposition: 'accepted',
          category: null,
          severity: 'high',
          location: 'src/a.ts:4',
        },
      ],
    }),
    findingsPath: () => '/state/review.json',
    write: () => {},
    run: () => ({ exitCode: 0, stdout: '', stderr: '' }),
    ...overrides,
  }
}

test('writes finished review findings and runs the declared argv in the requested tree', () => {
  let written: ReviewRecordFindingsFile | undefined
  let invocation: { argv: string[]; cwd: string } | undefined
  const reason = `correctness accepted; preserve "quoted" behavior`
  recordProjectReviewCommand(
    'DEV-1110-record',
    '/worktree',
    reason,
    { log() {} },
    {
      ...operations(),
      write: (_path, findings) => {
        written = findings
      },
      run: (argv, cwd) => {
        invocation = { argv, cwd }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  )

  expect(written).toEqual({
    lenses: ['correctness'],
    findings: [
      {
        lens: 'correctness',
        verdict: 'accept',
        severity: 'high',
        location: 'src/a.ts:4',
        run: 71,
      },
    ],
    skipped: 0,
  })
  expect(invocation).toEqual({
    cwd: '/worktree',
    argv: [
      'project-review',
      'record',
      '--tier',
      '2',
      '--reason',
      reason,
      '--agents',
      '1',
      '--findings',
      '/state/review.json',
      '--branch',
      'DEV-1110-record',
    ],
  })
})

test('refuses incomplete triage with the judge remedy', () => {
  expect(() =>
    recordProjectReviewCommand(
      'DEV-1110-record',
      '/worktree',
      'correctness accepted',
      { log() {} },
      {
        ...operations(),
        review: () => ({ complete: false, tier: 2, rows: [] }),
      },
    ),
  ).toThrow(
    'review triage for DEV-1110-record is incomplete; finish every lens and finding with orch judge',
  )
})

test('a project without a declaration exits successfully with the stated result', () => {
  const output: string[] = []
  recordProjectReviewCommand(
    'DEV-1110-record',
    '/worktree',
    'no lenses required',
    {
      log: (...values) => output.push(values.join(' ')),
    },
    {
      ...operations(),
      project: () => ({ name: 'fixture', settings: { review: { lenses: [] } } }),
      review: () => {
        throw new Error('review resolution must not run without a declaration')
      },
    },
  )
  expect(output).toEqual(['project fixture declares no review record'])
})

test('a failed project command reports its output', () => {
  expect(() =>
    recordProjectReviewCommand(
      'DEV-1110-record',
      '/worktree',
      'correctness accepted',
      { log() {} },
      {
        ...operations(),
        run: () => ({ exitCode: 7, stdout: 'record stdout', stderr: 'record stderr' }),
      },
    ),
  ).toThrow(
    /record stdout\nrecord stderr\ncleared by: fix the project's review record command or its inputs/,
  )
})

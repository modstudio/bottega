import { describe, expect, test } from 'bun:test'
import {
  type IssueReviewLensResult,
  issueReviewDecision,
  issueReviewDidNotRun,
  issueReviewEvidence,
  issueReviewLenses,
  issueReviewRunLabel,
  issueReviewStartEvidence,
  parseIssueReviewRunLabel,
} from './issue-review.ts'

const clean = (lens: string): IssueReviewLensResult => ({
  lens,
  finished: true,
  failedToRun: null,
  findingCount: 0,
  findings: [],
  runId: 1,
})

describe('filed issue review policy', () => {
  test('adds blast radius to tiers selecting two lenses, one lens, or none', () => {
    expect(issueReviewLenses(['correctness', 'craft'])).toEqual([
      'issue-blast-radius',
      'correctness',
      'craft',
    ])
    expect(issueReviewLenses(['correctness'])).toEqual(['issue-blast-radius', 'correctness'])
    expect(issueReviewLenses([])).toEqual(['issue-blast-radius'])
  })

  test('requires every lens to finish cleanly', () => {
    expect(issueReviewDecision([clean('issue-blast-radius'), clean('correctness')])).toEqual({
      ready: true,
      reviewNotStarted: null,
      lensesWithFindings: [],
      lensesNotRun: [],
    })
    expect(
      issueReviewDecision([
        clean('issue-blast-radius'),
        { ...clean('correctness'), findingCount: 1, findings: [{ severity: 'high' }] },
      ]),
    ).toEqual({
      ready: false,
      reviewNotStarted: null,
      lensesWithFindings: ['correctness'],
      lensesNotRun: [],
    })
    expect(
      issueReviewDecision([
        clean('issue-blast-radius'),
        {
          lens: 'correctness',
          finished: false,
          failedToRun: 'harness refused to start',
          findingCount: null,
          findings: null,
          runId: null,
        },
      ]),
    ).toEqual({
      ready: false,
      reviewNotStarted: null,
      lensesWithFindings: [],
      lensesNotRun: ['correctness'],
    })
  })

  test('review setup failure is not ready and its evidence names why review did not start', () => {
    const reason = 'fix run 42 has no worktree to review'
    expect(issueReviewDecision([], reason)).toEqual({
      ready: false,
      reviewNotStarted: reason,
      lensesWithFindings: [],
      lensesNotRun: [],
    })
    expect(issueReviewStartEvidence(reason)).toBe(`Review did not start: ${reason}`)
  })

  test('handback evidence names a lens that did not run and why', () => {
    const evidence = issueReviewEvidence({
      lens: 'craft',
      finished: false,
      failedToRun: 'agent exited before returning review output',
      findingCount: null,
      findings: null,
      runId: 42,
    })
    expect(evidence).toContain('craft lens run: 42; did not run')
    expect(evidence).toContain('agent exited before returning review output')
  })

  test('a null finding count uses the same did-not-run ruling in decision and evidence', () => {
    const result = { ...clean('correctness'), findingCount: null }
    expect(issueReviewDidNotRun(result)).toBe(true)
    expect(issueReviewDecision([result]).lensesNotRun).toEqual(['correctness'])
    expect(issueReviewEvidence(result)).toContain('correctness lens run: 1; did not run')
  })

  test('one review label grammar formats and parses every coordinator lens', () => {
    expect(issueReviewRunLabel('DEV-1', 'correctness')).toBe('issue DEV-1 review correctness')
    expect(issueReviewRunLabel('DEV-1', 'issue-blast-radius')).toBe(
      'issue DEV-1 review issue-blast-radius',
    )
    expect(parseIssueReviewRunLabel('issue DEV-1 review correctness')).toEqual({
      issueKey: 'DEV-1',
      lens: 'correctness',
    })
    expect(parseIssueReviewRunLabel('issue DEV-1 blast radius')).toBeNull()
  })
})

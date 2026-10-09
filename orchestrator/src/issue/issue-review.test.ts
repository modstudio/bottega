import { describe, expect, test } from 'bun:test'
import {
  type IssueReviewLensResult,
  issueReviewDecision,
  issueReviewEvidence,
  issueReviewLenses,
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
      lensesWithFindings: [],
      lensesNotRun: [],
    })
    expect(
      issueReviewDecision([
        clean('issue-blast-radius'),
        { ...clean('correctness'), findingCount: 1, findings: [{ severity: 'high' }] },
      ]),
    ).toEqual({ ready: false, lensesWithFindings: ['correctness'], lensesNotRun: [] })
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
    ).toEqual({ ready: false, lensesWithFindings: [], lensesNotRun: ['correctness'] })
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
})

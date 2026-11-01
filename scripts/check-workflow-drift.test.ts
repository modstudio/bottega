import { describe, expect, test } from 'bun:test'
import { workflowDriftPartition, workflowDriftReport } from './check-workflow-drift.ts'

describe('workflow drift branch gate', () => {
  test('reports drift outside the branch as informational without failing', () => {
    expect(
      workflowDriftPartition(
        ['.agents/workflows/review-fleet.md', '.agents/workflow-steps/catalogue.md'],
        ['.agents/workflows/review-fleet.md', '.agents/workflow-steps/catalogue.md'],
        ['README.md'],
      ),
    ).toEqual({
      failing: [],
      informational: ['.agents/workflows/review-fleet.md', '.agents/workflow-steps/catalogue.md'],
    })
  })

  test('fails drift changed by the branch and keeps other drift informational', () => {
    expect(
      workflowDriftPartition(
        ['.agents/workflows/review-fleet.md', '.agents/workflow-sequences/review.md'],
        ['.agents/workflows/review-fleet.md', '.agents/workflow-sequences/review.md'],
        ['.agents/workflows/review-fleet.md'],
      ),
    ).toEqual({
      failing: ['.agents/workflows/review-fleet.md'],
      informational: ['.agents/workflow-sequences/review.md'],
    })
  })

  test('reports import for branch changes and hydrate for a stale tree', () => {
    const failingPath = '.agents/workflow-steps/blast-radius.md'
    const informationalPath = '.agents/workflow-steps/review-lenses.md'
    const report = workflowDriftReport({
      failing: [failingPath],
      informational: [informationalPath],
    })

    expect(report.failing[0]).toContain(failingPath)
    expect(report.failing[0]).toContain('workflow import')
    expect(report.failing[0]).not.toContain('workflow hydrate')
    expect(report.informational).toContain(informationalPath)
    expect(report.informational).toContain('workflow hydrate')
  })

  test('accepts a branch-changed file matching its newest draft', () => {
    expect(
      workflowDriftPartition(
        ['.agents/workflows/review-fleet.md'],
        [],
        ['.agents/workflows/review-fleet.md'],
      ),
    ).toEqual({ failing: [], informational: [] })
  })

  test('accepts a branch-changed file matching production', () => {
    expect(
      workflowDriftPartition(
        [],
        ['.agents/workflows/review-fleet.md'],
        ['.agents/workflows/review-fleet.md'],
      ),
    ).toEqual({ failing: [], informational: [] })
  })
})

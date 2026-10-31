import { describe, expect, test } from 'bun:test'
import { workflowDriftPartition } from './check-workflow-drift.ts'

describe('workflow drift branch gate', () => {
  test('reports drift outside the branch as informational without failing', () => {
    expect(
      workflowDriftPartition(
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
        ['.agents/workflows/review-fleet.md'],
      ),
    ).toEqual({
      failing: ['.agents/workflows/review-fleet.md'],
      informational: ['.agents/workflow-sequences/review.md'],
    })
  })
})

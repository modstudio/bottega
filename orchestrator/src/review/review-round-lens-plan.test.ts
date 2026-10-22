import { describe, expect, test } from 'bun:test'
import type { TriageReviewRow } from './review-group.ts'
import { roundLensFacts, roundLensPlan } from './review-round-lens-plan.ts'

describe('round lens plan', () => {
  test('an initial round lists every relevant lens', () => {
    expect(
      roundLensPlan({
        relevantLenses: ['correctness', 'craft', 'architecture'],
        completedLenses: [],
        latestAcceptedOrModifiedLenses: [],
        newlyTouchedLenses: [],
      }),
    ).toEqual(['correctness', 'craft', 'architecture'])
  })

  test('a later round keeps findings and newly touched concerns but drops a clean lens', () => {
    expect(
      roundLensPlan({
        relevantLenses: ['correctness', 'craft', 'test-quality', 'architecture', 'safety'],
        completedLenses: ['correctness', 'craft', 'test-quality', 'architecture', 'safety'],
        latestAcceptedOrModifiedLenses: ['correctness', 'craft', 'test-quality'],
        newlyTouchedLenses: ['safety'],
      }),
    ).toEqual(['correctness', 'craft', 'test-quality', 'safety'])
  })

  test('a never-completed relevant lens remains in a later round', () => {
    expect(
      roundLensPlan({
        relevantLenses: ['correctness', 'craft'],
        completedLenses: ['correctness'],
        latestAcceptedOrModifiedLenses: [],
        newlyTouchedLenses: [],
      }),
    ).toEqual(['craft'])
  })

  test('facts use the latest prior round and attribute accepted and modified findings by lens', () => {
    const row = (
      reviewNumber: number,
      patchId: string,
      lens: string,
      disposition: string | null,
    ): TriageReviewRow => ({
      reviewRecordId: `review-${reviewNumber}-${lens}`,
      reviewNumber,
      recordedAt: `2026-10-2${reviewNumber}T00:00:00Z`,
      completedAt: `2026-10-2${reviewNumber}T01:00:00Z`,
      tier: 3,
      patchId,
      pathSet: '["a.ts"]',
      lensIdentities: [lens],
      lenses: [{ recordId: `lens-${reviewNumber}-${lens}`, lens, graded: true }],
      findings: [
        {
          recordId: `finding-${reviewNumber}-${lens}`,
          ordinal: 1,
          disposition,
          lens,
        },
      ],
    })
    expect(
      roundLensFacts(
        [
          row(5, 'current', 'correctness', 'accepted'),
          row(4, 'latest', 'correctness', 'accepted'),
          row(4, 'latest', 'craft', 'modified'),
          row(4, 'latest', 'architecture', 'rejected'),
          row(3, 'older', 'safety', 'accepted'),
        ],
        { patchId: 'current', pathSet: '["a.ts"]' },
      ),
    ).toEqual({
      completedLenses: ['correctness', 'craft', 'architecture', 'safety'],
      latestAcceptedOrModifiedLenses: ['correctness', 'craft'],
    })
  })
})

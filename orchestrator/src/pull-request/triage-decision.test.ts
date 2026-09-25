import { describe, expect, test } from 'bun:test'
import { decideTriage, type TriageEvidence } from './triage-decision.ts'

const evidence = (overrides: Partial<TriageEvidence> = {}): TriageEvidence => ({
  patchId: 'patch-a',
  tier: 1,
  reviews: [
    {
      reviewId: 4,
      completedAt: '2026-09-25T00:00:00Z',
      lensIds: [8],
      findings: [{ id: 12, ordinal: 1, disposition: 'accepted' }],
    },
  ],
  ...overrides,
})

describe('pull-request triage decision', () => {
  test('tier zero needs no review', () => {
    expect(decideTriage(evidence({ tier: 0, reviews: [] }))).toMatchObject({ complete: true })
  })

  test('complete evidence is admitted', () => {
    expect(decideTriage(evidence())).toEqual({
      complete: true,
      snapshot: {
        reviewIds: [4],
        patchId: 'patch-a',
        tier: 1,
        lensRounds: 1,
        findingCount: 1,
      },
    })
  })

  test('reports an unfinished review', () => {
    const reviews = [{ ...evidence().reviews[0]!, completedAt: null }]
    expect(decideTriage(evidence({ reviews }))).toMatchObject({
      complete: false,
      unfinishedReviewIds: [4],
    })
  })

  test('reports an undisposed finding', () => {
    const reviews = [
      {
        ...evidence().reviews[0]!,
        findings: [{ id: 12, ordinal: 1, disposition: null }],
      },
    ]
    expect(decideTriage(evidence({ reviews }))).toMatchObject({
      complete: false,
      undisposedFindings: [{ id: 12, reviewId: 4, ordinal: 1 }],
    })
  })

  test('reports lens rounds owed for the tier', () => {
    expect(decideTriage(evidence({ tier: 3 }))).toMatchObject({
      complete: false,
      roundsOwed: 2,
    })
  })

  test('a missing exact patch group is unreviewed', () => {
    expect(decideTriage(evidence({ patchId: 'different-patch', reviews: [] }))).toMatchObject({
      complete: false,
      missingReview: true,
    })
  })
})

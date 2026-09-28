import { describe, expect, test } from 'bun:test'
import { decideTriage, type TriageEvidence } from './triage-decision.ts'

const review = (overrides: Partial<TriageEvidence['reviews'][number]> = {}) => ({
  reviewId: 4,
  recordedAt: '2026-09-25T00:00:00Z',
  completedAt: '2026-09-25T01:00:00Z',
  tier: 1 as const,
  patchId: 'patch-old',
  pathSet: '["a.ts"]',
  lensIds: [8],
  findings: [{ id: 12, ordinal: 1, disposition: 'accepted' }],
  ...overrides,
})

const evidence = (overrides: Partial<TriageEvidence> = {}): TriageEvidence => ({
  patchId: 'patch-a',
  pathSet: '["a.ts"]',
  tip: 'tip-a',
  tier: 1,
  branchOwnerSession: 'owner-session',
  reviews: [review({ patchId: 'patch-a' })],
  branchReviews: [],
  reads: [],
  ...overrides,
})

describe('pull-request triage decision', () => {
  test('tier zero needs no review', () => {
    expect(decideTriage(evidence({ tier: 0, reviews: [] }))).toMatchObject({ complete: true })
  })

  test('path a admits unchanged complete exact evidence', () => {
    expect(decideTriage(evidence())).toEqual({
      complete: true,
      snapshot: {
        reviewIds: [4],
        patchId: 'patch-a',
        tier: 1,
        lensRounds: 1,
        findingCount: 1,
        admissionPath: 'exact_review',
        readId: null,
      },
    })
  })

  test('path b admits a complete earlier round plus a later read of the exact tip', () => {
    const earlier = review({ reviewId: 3, tier: 2, lensIds: [6, 7] })
    expect(
      decideTriage(
        evidence({
          tier: 2,
          reviews: [],
          branchReviews: [earlier],
          reads: [
            {
              id: 9,
              tip: 'tip-a',
              patchId: 'patch-a',
              pathSet: '["a.ts"]',
              recordedAt: '2026-09-25T02:00:00Z',
              sessionId: 'owner-session',
            },
          ],
        }),
      ),
    ).toMatchObject({
      complete: true,
      snapshot: { admissionPath: 'architect_read', reviewIds: [3], readId: 9 },
    })
  })

  test.each([
    ['without the read', []],
    [
      'with a read of a different patch',
      [
        {
          id: 9,
          tip: 'tip-a',
          patchId: 'other',
          pathSet: '["a.ts"]',
          recordedAt: '2026-09-25T02:00:00Z',
          sessionId: 'owner-session',
        },
      ],
    ],
    [
      'with a read recorded before the round completed',
      [
        {
          id: 9,
          tip: 'tip-a',
          patchId: 'patch-a',
          pathSet: '["a.ts"]',
          recordedAt: '2026-09-25T00:30:00Z',
          sessionId: 'owner-session',
        },
      ],
    ],
  ])('path b refuses %s', (_label, reads) => {
    expect(decideTriage(evidence({ reviews: [], branchReviews: [review()], reads }))).toMatchObject(
      {
        complete: false,
        architectReadRequired: true,
      },
    )
  })

  test('path b refuses an incomplete earlier round', () => {
    expect(
      decideTriage(
        evidence({
          reviews: [],
          branchReviews: [review({ completedAt: null })],
          reads: [
            {
              id: 9,
              tip: 'tip-a',
              patchId: 'patch-a',
              pathSet: '["a.ts"]',
              recordedAt: '2026-09-25T02:00:00Z',
              sessionId: 'owner-session',
            },
          ],
        }),
      ),
    ).toMatchObject({ complete: false, earlierReviewId: null })
  })

  test('path b refuses a read not recorded by the branch run owner', () => {
    expect(
      decideTriage(
        evidence({
          reviews: [],
          branchReviews: [review()],
          reads: [
            {
              id: 9,
              tip: 'tip-a',
              patchId: 'patch-a',
              pathSet: '["a.ts"]',
              recordedAt: '2026-09-25T02:00:00Z',
              sessionId: 'foreign-session',
            },
          ],
        }),
      ),
    ).toMatchObject({ complete: false, architectReadRequired: true })
  })

  test('path b refuses when the final tier exceeds the credited round tier', () => {
    expect(
      decideTriage(
        evidence({
          tier: 2,
          reviews: [],
          branchReviews: [review()],
          reads: [
            {
              id: 9,
              tip: 'tip-a',
              patchId: 'patch-a',
              pathSet: '["a.ts"]',
              recordedAt: '2026-09-25T02:00:00Z',
              sessionId: 'owner-session',
            },
          ],
        }),
      ),
    ).toMatchObject({ complete: false, finalTierRaised: true, earlierReviewTier: 1 })
  })

  test('reports unfinished exact review, undisposed findings, and rounds owed', () => {
    const incomplete = review({
      completedAt: null,
      findings: [{ id: 12, ordinal: 1, disposition: null }],
    })
    expect(decideTriage(evidence({ tier: 3, reviews: [incomplete] }))).toMatchObject({
      complete: false,
      unfinishedReviewIds: [4],
      undisposedFindings: [{ id: 12, reviewId: 4, ordinal: 1 }],
      roundsOwed: 2,
    })
  })
})

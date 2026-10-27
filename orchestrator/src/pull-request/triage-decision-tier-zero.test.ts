import { describe, expect, test } from 'bun:test'
import { decideTriage, type TriageEvidence } from './triage-decision.ts'

const review = (
  overrides: Partial<TriageEvidence['reviews'][number]> & { reviewId?: number } = {},
) => {
  const { reviewId = 4, ...rest } = overrides
  const lensIdentities = rest.lensIdentities ?? ['correctness']
  return {
    reviewRecordId: `review-${reviewId}`,
    reviewNumber: reviewId,
    recordedAt: '2026-09-25T00:00:00Z',
    completedAt: '2026-09-25T01:00:00Z',
    tier: 1 as const,
    role: 'round' as const,
    patchId: 'patch-old',
    pathSet: '["a.ts"]',
    lensIdentities,
    lenses: lensIdentities.map((lens, index) => ({
      recordId: `lens-${reviewId}-${index}`,
      lens,
      graded: true,
      settled: true,
    })),
    findings: [{ recordId: 'finding-12', ordinal: 1, disposition: 'accepted' }],
    ...rest,
  }
}

const evidence = (overrides: Partial<TriageEvidence> = {}): TriageEvidence => ({
  patchId: 'patch-a',
  pathSet: '["a.ts"]',
  tip: 'tip-a',
  tier: 1,
  applicableReview: { lenses: ['correctness'] },
  branchOwnerSession: 'owner-session',
  reviews: [review({ patchId: 'patch-a' })],
  branchReviewGroups: [],
  reads: [],
  ...overrides,
})

describe('pull-request triage decision at tier zero', () => {
  const ownerRead = (overrides: Partial<TriageEvidence['reads'][number]> = {}) => ({
    recordId: 'record-9',
    tip: 'tip-a',
    patchId: 'patch-a',
    pathSet: '["a.ts"]',
    recordedAt: '2026-09-25T02:00:00Z',
    sessionId: 'owner-session',
    ...overrides,
  })

  test('tier zero without a read refuses', () => {
    expect(
      decideTriage(evidence({ tier: 0, applicableReview: { lenses: [] }, reviews: [] })),
    ).toMatchObject({ complete: false, architectReadRequired: true })
  })

  test('tier zero admits an exact owner-recorded read of the tip', () => {
    expect(
      decideTriage(
        evidence({
          tier: 0,
          applicableReview: { lenses: [] },
          reviews: [],
          reads: [ownerRead()],
        }),
      ),
    ).toEqual({
      complete: true,
      snapshot: {
        reviewRecordIds: [],
        patchId: 'patch-a',
        tier: 0,
        lensRounds: 0,
        findingCount: 0,
        admissionPath: 'architect_read',
        readRecordId: 'record-9',
      },
    })
  })

  test('tier zero refuses a read of another tip', () => {
    expect(
      decideTriage(
        evidence({
          tier: 0,
          applicableReview: { lenses: [] },
          reviews: [],
          reads: [ownerRead({ tip: 'tip-other' })],
        }),
      ),
    ).toMatchObject({ complete: false, architectReadRequired: true })
  })

  test('tier zero refuses a read not recorded by the branch run owner', () => {
    expect(
      decideTriage(
        evidence({
          tier: 0,
          applicableReview: { lenses: [] },
          reviews: [],
          reads: [ownerRead({ sessionId: 'foreign-session' })],
        }),
      ),
    ).toMatchObject({ complete: false, architectReadRequired: true })
  })

  const tierZero = (overrides: Partial<TriageEvidence> = {}) =>
    evidence({ tier: 0, applicableReview: { lenses: [] }, reviews: [], ...overrides })

  test('tier zero refuses a read of another path set', () => {
    expect(decideTriage(tierZero({ reads: [ownerRead({ pathSet: '["b.ts"]' })] }))).toMatchObject({
      complete: false,
      architectReadRequired: true,
    })
  })

  test('tier zero admits an identified read on a branch no run owns', () => {
    expect(
      decideTriage(
        tierZero({
          branchOwnerSession: null,
          reads: [ownerRead({ sessionId: 'architect-session' })],
        }),
      ),
    ).toMatchObject({
      complete: true,
      snapshot: { admissionPath: 'architect_read', readRecordId: 'record-9' },
    })
  })

  test.each([
    ['an owned branch', 'owner-session'],
    ['a branch no run owns', null],
  ])('tier zero refuses a read with no session on %s', (_label, branchOwnerSession) => {
    expect(
      decideTriage(tierZero({ branchOwnerSession, reads: [ownerRead({ sessionId: null })] })),
    ).toMatchObject({ complete: false, architectReadRequired: true })
  })

  test('tier zero refuses a matching read while the exact patch has an unfinished review', () => {
    expect(
      decideTriage(
        tierZero({
          reviews: [review({ patchId: 'patch-a', completedAt: null })],
          reads: [ownerRead()],
        }),
      ),
    ).toMatchObject({ complete: false, unfinishedReviewNumbers: [4] })
  })

  test('tier zero refuses a matching read while the exact patch has an undisposed finding', () => {
    const finding = { recordId: 'finding-12', ordinal: 1, disposition: null }
    expect(
      decideTriage(
        tierZero({
          reviews: [review({ patchId: 'patch-a', findings: [finding] })],
          reads: [ownerRead()],
        }),
      ),
    ).toMatchObject({ complete: false, undisposedFindings: [{ reviewNumber: 4, ordinal: 1 }] })
  })
})

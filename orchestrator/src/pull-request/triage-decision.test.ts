import { describe, expect, test } from 'bun:test'
import { decideSecondOpinion, decideTriage, type TriageEvidence } from './triage-decision.ts'

const review = (overrides: Partial<TriageEvidence['reviews'][number]> = {}) => ({
  reviewId: 4,
  recordedAt: '2026-09-25T00:00:00Z',
  completedAt: '2026-09-25T01:00:00Z',
  tier: 1 as const,
  patchId: 'patch-old',
  pathSet: '["a.ts"]',
  lensIdentities: ['correctness'],
  lenses: [{ id: 1, graded: true }],
  findings: [{ id: 12, ordinal: 1, disposition: 'accepted' }],
  ...overrides,
})

const branchGroup = (
  reviews: TriageEvidence['reviews'],
  applicableLenses: readonly string[] = ['correctness'],
  secondOpinion?: string,
) => ({ reviews, applicableReview: { lenses: [...applicableLenses], secondOpinion } })

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

describe('pull-request triage decision', () => {
  test('tier zero needs no review', () => {
    expect(
      decideTriage(evidence({ tier: 0, applicableReview: { lenses: [] }, reviews: [] })),
    ).toMatchObject({ complete: true })
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
    const earlier = review({
      reviewId: 3,
      tier: 2,
      lensIdentities: ['correctness', 'craft'],
    })
    expect(
      decideTriage(
        evidence({
          tier: 2,
          reviews: [],
          branchReviewGroups: [branchGroup([earlier], ['correctness', 'craft'])],
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

  test('path b credits a full pre-rebase round recorded as separate lens reviews', () => {
    const firstLens = review({
      reviewId: 3,
      tier: 2,
      lensIdentities: ['correctness'],
    })
    const secondLens = review({
      reviewId: 4,
      recordedAt: '2026-09-25T00:30:00Z',
      completedAt: '2026-09-25T01:30:00Z',
      tier: 2,
      lensIdentities: ['craft'],
    })
    expect(
      decideTriage(
        evidence({
          tier: 2,
          reviews: [],
          branchReviewGroups: [branchGroup([secondLens, firstLens], ['correctness', 'craft'])],
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
      snapshot: {
        admissionPath: 'architect_read',
        reviewIds: [3, 4],
        lensRounds: 2,
        readId: 9,
      },
    })
  })

  test('the same lens twice does not satisfy a tier-two exact review', () => {
    const first = review({
      reviewId: 3,
      tier: 2,
      lensIdentities: ['correctness'],
      patchId: 'patch-a',
    })
    const second = review({
      reviewId: 4,
      tier: 2,
      lensIdentities: ['correctness'],
      patchId: 'patch-a',
    })

    expect(
      decideTriage(
        evidence({
          tier: 2,
          applicableReview: { lenses: ['correctness', 'craft'] },
          reviews: [first, second],
        }),
      ),
    ).toMatchObject({ complete: false, missingLenses: ['craft'] })
  })

  test('an unfinished review blocks an otherwise complete identical patch group', () => {
    const complete = review({
      reviewId: 3,
      tier: 1,
      lensIdentities: ['correctness'],
      patchId: 'patch-a',
    })
    const unfinished = review({
      reviewId: 4,
      completedAt: null,
      tier: 1,
      lensIdentities: ['safety'],
      patchId: 'patch-a',
    })

    expect(decideTriage(evidence({ reviews: [complete, unfinished] }))).toMatchObject({
      complete: false,
      unfinishedReviewIds: [4],
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
    expect(
      decideTriage(
        evidence({
          reviews: [],
          branchReviewGroups: [branchGroup([review()])],
          reads,
        }),
      ),
    ).toMatchObject({
      complete: false,
      architectReadRequired: true,
    })
  })

  test('path b refuses an incomplete earlier round', () => {
    expect(
      decideTriage(
        evidence({
          reviews: [],
          branchReviewGroups: [branchGroup([review({ completedAt: null })])],
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
          branchReviewGroups: [branchGroup([review()])],
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
          branchReviewGroups: [branchGroup([review()])],
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
      complete: false,
      finalTierRaised: true,
      earlierReviewTier: 1,
    })
  })

  test('reports unfinished exact review, undisposed findings, and missing applicable lenses', () => {
    const incomplete = review({
      completedAt: null,
      findings: [{ id: 12, ordinal: 1, disposition: null }],
    })
    expect(
      decideTriage(
        evidence({
          tier: 3,
          applicableReview: { lenses: ['correctness', 'craft', 'safety'] },
          reviews: [incomplete],
        }),
      ),
    ).toMatchObject({
      complete: false,
      unfinishedReviewIds: [4],
      undisposedFindings: [{ id: 12, reviewId: 4, ordinal: 1 }],
      missingLenses: ['correctness', 'craft', 'safety'],
    })
  })

  test('requires every applicable lens and allows an extra lens', () => {
    const required = review({
      lensIdentities: ['correctness', 'migration-safety'],
      patchId: 'patch-a',
    })
    expect(
      decideTriage(
        evidence({
          applicableReview: { lenses: ['correctness', 'migration-safety'] },
          reviews: [required],
        }),
      ),
    ).toMatchObject({ complete: true })
    expect(
      decideTriage(
        evidence({
          applicableReview: { lenses: ['correctness', 'craft'] },
          reviews: [required],
        }),
      ),
    ).toMatchObject({ complete: false, missingLenses: ['craft'] })
  })

  test('a second opinion requires two completed runs on different models', () => {
    const opinion = (id: number, model: string) => ({
      id,
      runId: String(id + 100),
      lens: 'correctness',
      model,
      graded: true,
    })
    const withOpinions = (...opinions: ReturnType<typeof opinion>[]) => [
      review({ lenses: opinions }),
    ]

    expect(decideSecondOpinion(withOpinions(opinion(1, 'model-a')), 'correctness')).toEqual({
      complete: false,
      lens: 'correctness',
      firstRunId: '101',
    })
    expect(
      decideSecondOpinion(
        withOpinions(opinion(1, 'model-a'), opinion(2, 'model-a')),
        'correctness',
      ),
    ).toEqual({ complete: false, lens: 'correctness', firstRunId: '101' })
    expect(
      decideSecondOpinion(
        withOpinions(opinion(1, 'model-a'), opinion(2, 'model-b')),
        'correctness',
      ),
    ).toEqual({ complete: true })
  })

  test('a second opinion is enforced on exact and earlier credited review rounds', () => {
    const twoModels = review({
      patchId: 'patch-a',
      lenses: [
        { id: 1, runId: '101', lens: 'correctness', model: 'model-a', graded: true },
        { id: 2, runId: '102', lens: 'correctness', model: 'model-b', graded: true },
      ],
    })
    expect(
      decideTriage(
        evidence({
          applicableReview: { lenses: ['correctness'], secondOpinion: 'correctness' },
          reviews: [twoModels],
        }),
      ),
    ).toMatchObject({ complete: true, snapshot: { lensRounds: 2 } })

    expect(
      decideTriage(
        evidence({
          reviews: [],
          applicableReview: { lenses: ['correctness'], secondOpinion: 'correctness' },
          branchReviewGroups: [branchGroup([twoModels], ['correctness'], 'correctness')],
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
      snapshot: { admissionPath: 'architect_read', lensRounds: 2 },
    })

    const sameModel = review({
      patchId: 'patch-a',
      lenses: [
        { id: 1, runId: '101', lens: 'correctness', model: 'model-a', graded: true },
        { id: 2, runId: '102', lens: 'correctness', model: 'model-a', graded: true },
      ],
    })
    expect(
      decideTriage(
        evidence({
          applicableReview: { lenses: ['correctness'], secondOpinion: 'correctness' },
          reviews: [sameModel],
        }),
      ),
    ).toMatchObject({
      complete: false,
      missingSecondOpinion: { lens: 'correctness', firstRunId: '101' },
    })

    expect(
      decideTriage(
        evidence({
          reviews: [],
          applicableReview: { lenses: ['correctness'], secondOpinion: 'correctness' },
          branchReviewGroups: [branchGroup([sameModel], ['correctness'], 'correctness')],
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
})

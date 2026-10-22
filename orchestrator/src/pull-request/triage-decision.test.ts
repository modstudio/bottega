import { describe, expect, test } from 'bun:test'
import { decideSecondOpinion, decideTriage, type TriageEvidence } from './triage-decision.ts'

const review = (
  overrides: Partial<TriageEvidence['reviews'][number]> & { reviewId?: number } = {},
) => {
  const { reviewId = 4, ...rest } = overrides
  return {
    reviewRecordId: `review-${reviewId}`,
    reviewNumber: reviewId,
    recordedAt: '2026-09-25T00:00:00Z',
    completedAt: '2026-09-25T01:00:00Z',
    tier: 1 as const,
    patchId: 'patch-old',
    pathSet: '["a.ts"]',
    lensIdentities: ['correctness'],
    lenses: [{ recordId: 'lens-1', graded: true }],
    findings: [{ recordId: 'finding-12', ordinal: 1, disposition: 'accepted' }],
    ...rest,
  }
}

const branchGroup = (reviews: TriageEvidence['reviews']) => ({ reviews })

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
        reviewRecordIds: ['review-4'],
        patchId: 'patch-a',
        tier: 1,
        lensRounds: 1,
        findingCount: 1,
        admissionPath: 'exact_review',
        readRecordId: null,
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
          applicableReview: { lenses: ['correctness', 'craft'] },
          branchReviewGroups: [branchGroup([earlier])],
          reads: [
            {
              recordId: 'record-9',
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
        reviewRecordIds: ['review-3'],
        readRecordId: 'record-9',
      },
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
          applicableReview: { lenses: ['correctness', 'craft'] },
          branchReviewGroups: [branchGroup([secondLens, firstLens])],
          reads: [
            {
              recordId: 'record-9',
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
        reviewRecordIds: ['review-3', 'review-4'],
        lensRounds: 2,
        readRecordId: 'record-9',
      },
    })
  })

  test('path b composes five required lenses across two earlier patch groups', () => {
    const firstPatch = review({
      reviewId: 3,
      completedAt: '2026-09-25T01:00:00Z',
      tier: 3,
      patchId: 'patch-first',
      lensIdentities: ['correctness', 'craft', 'safety'],
      lenses: [
        { recordId: 'lens-correctness', lens: 'correctness', graded: true },
        { recordId: 'lens-craft', lens: 'craft', graded: true },
        { recordId: 'lens-safety', lens: 'safety', graded: true },
      ],
    })
    const secondPatch = review({
      reviewId: 4,
      completedAt: '2026-09-25T02:00:00Z',
      tier: 3,
      patchId: 'patch-second',
      lensIdentities: ['boundaries', 'tests'],
      lenses: [
        { recordId: 'lens-boundaries', lens: 'boundaries', graded: true },
        { recordId: 'lens-tests', lens: 'tests', graded: true },
      ],
    })
    expect(
      decideTriage(
        evidence({
          tier: 3,
          applicableReview: {
            lenses: ['correctness', 'craft', 'safety', 'boundaries', 'tests'],
          },
          reviews: [],
          branchReviewGroups: [branchGroup([secondPatch]), branchGroup([firstPatch])],
          reads: [
            {
              recordId: 'record-9',
              tip: 'tip-a',
              patchId: 'patch-a',
              pathSet: '["a.ts"]',
              recordedAt: '2026-09-25T03:00:00Z',
              sessionId: 'owner-session',
            },
          ],
        }),
      ),
    ).toMatchObject({
      complete: true,
      snapshot: {
        admissionPath: 'architect_read',
        reviewRecordIds: ['review-3', 'review-4'],
        lensRounds: 5,
        readRecordId: 'record-9',
      },
    })
  })

  test('DEV-1524 admits five lenses composed across three groups after its tier rose', () => {
    const lensReview = (
      reviewId: number,
      tier: 2 | 3,
      patchId: string,
      lens: string,
      completedAt: string,
    ) =>
      review({
        reviewId,
        tier,
        patchId,
        lensIdentities: [lens],
        lenses: [{ recordId: `lens-${reviewId}`, lens, graded: true }],
        findings: [],
        completedAt,
      })
    const firstRound = [
      lensReview(6079, 2, 'patch-first', 'craft', '2026-10-22T00:33:52.265Z'),
      lensReview(6084, 2, 'patch-first', 'test-quality', '2026-10-22T00:40:24.519Z'),
      lensReview(6086, 2, 'patch-first', 'correctness', '2026-10-22T00:44:33.926Z'),
    ]
    const tierThreeRound = [
      lensReview(6116, 3, 'patch-second', 'architecture', '2026-10-22T01:26:48.397Z'),
      lensReview(6117, 3, 'patch-second', 'correctness', '2026-10-22T01:26:47.857Z'),
      lensReview(6118, 3, 'patch-second', 'teardown-safety', '2026-10-22T01:27:56.173Z'),
    ]
    const completingRound = [
      lensReview(6125, 3, 'patch-third', 'craft', '2026-10-22T02:01:03.669Z'),
      lensReview(6126, 3, 'patch-third', 'test-quality', '2026-10-22T02:01:04.170Z'),
    ]

    expect(
      decideTriage(
        evidence({
          tier: 3,
          applicableReview: {
            lenses: ['correctness', 'craft', 'test-quality', 'architecture', 'teardown-safety'],
          },
          reviews: [],
          branchReviewGroups: [
            branchGroup(completingRound),
            branchGroup(tierThreeRound),
            branchGroup(firstRound),
          ],
          reads: [
            {
              recordId: 'dev-1524-read',
              tip: 'tip-a',
              patchId: 'patch-a',
              pathSet: '["a.ts"]',
              recordedAt: '2026-10-22T03:00:00Z',
              sessionId: 'owner-session',
            },
          ],
        }),
      ),
    ).toMatchObject({ complete: true, snapshot: { admissionPath: 'architect_read' } })
  })

  test('a satisfied correctness second opinion plus a missing safety lens reports only safety', () => {
    const correctness = (reviewId: number, model: string, completedAt: string) =>
      review({
        reviewId,
        tier: 3,
        completedAt,
        lensIdentities: ['correctness'],
        lenses: [
          {
            recordId: `lens-${reviewId}`,
            runId: `run-${reviewId}`,
            lens: 'correctness',
            model,
            graded: true,
          },
        ],
        findings: [],
      })

    expect(
      decideTriage(
        evidence({
          tier: 3,
          applicableReview: {
            lenses: ['correctness', 'safety'],
            secondOpinion: 'correctness',
          },
          reviews: [],
          branchReviewGroups: [
            branchGroup([
              correctness(2, 'model-b', '2026-09-25T02:00:00Z'),
              correctness(1, 'model-a', '2026-09-25T01:00:00Z'),
            ]),
          ],
        }),
      ),
    ).toMatchObject({
      complete: false,
      missingLenses: ['safety'],
      missingSecondOpinion: null,
      undisposedFindings: [],
    })
  })

  test('a completed lens with an undisposed finding reports the finding, not a missing lens', () => {
    const incomplete = review({
      patchId: 'patch-a',
      completedAt: '2026-09-25T01:00:00Z',
      findings: [{ recordId: 'finding-1', ordinal: 1, disposition: null }],
    })

    expect(decideTriage(evidence({ reviews: [incomplete] }))).toMatchObject({
      complete: false,
      missingLenses: [],
      undisposedFindings: [{ reviewNumber: 4, ordinal: 1 }],
    })
  })

  test('path b refuses when the latest completed run of a lens has an undisposed finding', () => {
    const olderClean = review({
      reviewId: 3,
      completedAt: '2026-09-25T01:00:00Z',
      patchId: 'patch-first',
      findings: [],
    })
    const latestUndisposed = review({
      reviewId: 4,
      completedAt: '2026-09-25T02:00:00Z',
      patchId: 'patch-second',
      findings: [{ recordId: 'finding-latest', ordinal: 1, disposition: null }],
    })
    expect(
      decideTriage(
        evidence({
          reviews: [],
          branchReviewGroups: [branchGroup([latestUndisposed]), branchGroup([olderClean])],
          reads: [
            {
              recordId: 'record-9',
              tip: 'tip-a',
              patchId: 'patch-a',
              pathSet: '["a.ts"]',
              recordedAt: '2026-09-25T03:00:00Z',
              sessionId: 'owner-session',
            },
          ],
        }),
      ),
    ).toMatchObject({ complete: false, earlierReviewNumber: null })
  })

  test('path b refuses and names a required lens never judged on the branch', () => {
    expect(
      decideTriage(
        evidence({
          applicableReview: { lenses: ['correctness', 'craft'] },
          reviews: [],
          branchReviewGroups: [branchGroup([review({ findings: [] })])],
          // A read that would credit a complete round, so only the missing lens can refuse.
          reads: [
            {
              recordId: 'read-1',
              tip: 'tip-a',
              patchId: 'patch-a',
              pathSet: '["a.ts"]',
              recordedAt: '2026-09-25T03:00:00Z',
              sessionId: 'owner-session',
            },
          ],
        }),
      ),
    ).toMatchObject({
      complete: false,
      earlierReviewNumber: null,
      missingLenses: expect.arrayContaining(['craft']),
    })
  })

  test('path b requires a read after the latest completion in a composed round', () => {
    const correctness = review({
      reviewId: 3,
      completedAt: '2026-09-25T01:00:00Z',
      lensIdentities: ['correctness'],
      findings: [],
    })
    const craft = review({
      reviewId: 4,
      completedAt: '2026-09-25T02:00:00Z',
      patchId: 'patch-second',
      lensIdentities: ['craft'],
      findings: [],
    })
    expect(
      decideTriage(
        evidence({
          applicableReview: { lenses: ['correctness', 'craft'] },
          reviews: [],
          branchReviewGroups: [branchGroup([craft]), branchGroup([correctness])],
          reads: [
            {
              recordId: 'record-9',
              tip: 'tip-a',
              patchId: 'patch-a',
              pathSet: '["a.ts"]',
              recordedAt: '2026-09-25T01:30:00Z',
              sessionId: 'owner-session',
            },
          ],
        }),
      ),
    ).toMatchObject({ complete: false, architectReadRequired: true })
  })

  test('path b refuses when the final tier exceeds a composed round tier', () => {
    const correctness = review({
      reviewId: 3,
      tier: 1,
      lensIdentities: ['correctness'],
      findings: [],
    })
    const craft = review({
      reviewId: 4,
      tier: 1,
      patchId: 'patch-second',
      lensIdentities: ['craft'],
      findings: [],
    })
    expect(
      decideTriage(
        evidence({
          tier: 2,
          applicableReview: { lenses: ['correctness', 'craft'] },
          reviews: [],
          branchReviewGroups: [branchGroup([craft]), branchGroup([correctness])],
          reads: [
            {
              recordId: 'record-9',
              tip: 'tip-a',
              patchId: 'patch-a',
              pathSet: '["a.ts"]',
              recordedAt: '2026-09-25T03:00:00Z',
              sessionId: 'owner-session',
            },
          ],
        }),
      ),
    ).toMatchObject({ complete: false, finalTierRaised: true, earlierReviewTier: 1 })
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
      reviewRecordId: '01990000-0000-7000-8000-000000000004',
      reviewNumber: 104,
      completedAt: null,
      tier: 1,
      lensIdentities: ['safety'],
      patchId: 'patch-a',
    })

    expect(decideTriage(evidence({ reviews: [complete, unfinished] }))).toMatchObject({
      complete: false,
      unfinishedReviewNumbers: [104],
    })
  })

  test.each([
    ['without the read', []],
    [
      'with a read of a different patch',
      [
        {
          recordId: 'record-9',
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
          recordId: 'record-9',
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
              recordId: 'record-9',
              tip: 'tip-a',
              patchId: 'patch-a',
              pathSet: '["a.ts"]',
              recordedAt: '2026-09-25T02:00:00Z',
              sessionId: 'owner-session',
            },
          ],
        }),
      ),
    ).toMatchObject({ complete: false, earlierReviewNumber: null })
  })

  test('path b refuses a read not recorded by the branch run owner', () => {
    expect(
      decideTriage(
        evidence({
          reviews: [],
          branchReviewGroups: [branchGroup([review()])],
          reads: [
            {
              recordId: 'record-9',
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
              recordId: 'record-9',
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
      findings: [{ recordId: 'record-12', ordinal: 1, disposition: null }],
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
      unfinishedReviewNumbers: [4],
      undisposedFindings: [{ reviewNumber: 4, ordinal: 1 }],
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
      recordId: `lens-${id}`,
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
        { recordId: 'record-1', runId: '101', lens: 'correctness', model: 'model-a', graded: true },
        { recordId: 'record-2', runId: '102', lens: 'correctness', model: 'model-b', graded: true },
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
          branchReviewGroups: [branchGroup([twoModels])],
          reads: [
            {
              recordId: 'record-9',
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
        { recordId: 'record-1', runId: '101', lens: 'correctness', model: 'model-a', graded: true },
        { recordId: 'record-2', runId: '102', lens: 'correctness', model: 'model-a', graded: true },
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
          branchReviewGroups: [branchGroup([sameModel])],
          reads: [
            {
              recordId: 'record-9',
              tip: 'tip-a',
              patchId: 'patch-a',
              pathSet: '["a.ts"]',
              recordedAt: '2026-09-25T02:00:00Z',
              sessionId: 'owner-session',
            },
          ],
        }),
      ),
    ).toMatchObject({ complete: false, earlierReviewNumber: null })
  })

  test('path b snapshots both review records credited for a second opinion', () => {
    const firstModel = review({
      reviewId: 3,
      completedAt: '2026-09-25T01:00:00Z',
      tier: 2,
      lenses: [
        {
          recordId: 'record-1',
          runId: '101',
          lens: 'correctness',
          model: 'model-a',
          graded: true,
        },
      ],
    })
    const secondModel = review({
      reviewId: 4,
      completedAt: '2026-09-25T02:00:00Z',
      tier: 3,
      patchId: 'patch-second',
      lenses: [
        {
          recordId: 'record-2',
          runId: '102',
          lens: 'correctness',
          model: 'model-b',
          graded: true,
        },
      ],
    })

    expect(
      decideTriage(
        evidence({
          tier: 3,
          reviews: [],
          applicableReview: { lenses: ['correctness'], secondOpinion: 'correctness' },
          branchReviewGroups: [branchGroup([secondModel]), branchGroup([firstModel])],
          reads: [
            {
              recordId: 'record-9',
              tip: 'tip-a',
              patchId: 'patch-a',
              pathSet: '["a.ts"]',
              recordedAt: '2026-09-25T03:00:00Z',
              sessionId: 'owner-session',
            },
          ],
        }),
      ),
    ).toEqual({
      complete: true,
      snapshot: {
        reviewRecordIds: ['review-3', 'review-4'],
        patchId: 'patch-a',
        tier: 3,
        lensRounds: 2,
        findingCount: 2,
        admissionPath: 'architect_read',
        readRecordId: 'record-9',
      },
    })
  })

  test('path b refuses an undisposed review needed for the second opinion', () => {
    const firstModel = review({
      reviewId: 3,
      completedAt: '2026-09-25T01:00:00Z',
      lenses: [
        {
          recordId: 'record-1',
          runId: '101',
          lens: 'correctness',
          model: 'model-a',
          graded: true,
        },
      ],
      findings: [{ recordId: 'finding-1', ordinal: 1, disposition: null }],
    })
    const secondModel = review({
      reviewId: 4,
      completedAt: '2026-09-25T02:00:00Z',
      patchId: 'patch-second',
      lenses: [
        {
          recordId: 'record-2',
          runId: '102',
          lens: 'correctness',
          model: 'model-b',
          graded: true,
        },
      ],
      findings: [],
    })

    expect(
      decideTriage(
        evidence({
          reviews: [],
          applicableReview: { lenses: ['correctness'], secondOpinion: 'correctness' },
          branchReviewGroups: [branchGroup([secondModel]), branchGroup([firstModel])],
          reads: [
            {
              recordId: 'record-9',
              tip: 'tip-a',
              patchId: 'patch-a',
              pathSet: '["a.ts"]',
              recordedAt: '2026-09-25T03:00:00Z',
              sessionId: 'owner-session',
            },
          ],
        }),
      ),
    ).toMatchObject({ complete: false, earlierReviewNumber: null })
  })

  test('unfinished exact evidence cannot be bypassed by a creditable round and read', () => {
    const unfinished = review({
      reviewId: 5,
      patchId: 'patch-a',
      completedAt: null,
      findings: [{ recordId: 'finding-1', ordinal: 1, disposition: null }],
    })
    expect(
      decideTriage(
        evidence({
          reviews: [unfinished],
          branchReviewGroups: [branchGroup([review({ findings: [] })])],
          reads: [
            {
              recordId: 'record-9',
              tip: 'tip-a',
              patchId: 'patch-a',
              pathSet: '["a.ts"]',
              recordedAt: '2026-09-25T03:00:00Z',
              sessionId: 'owner-session',
            },
          ],
        }),
      ),
    ).toMatchObject({
      complete: false,
      unfinishedReviewNumbers: [5],
      undisposedFindings: [{ reviewNumber: 5, ordinal: 1 }],
    })
  })
})

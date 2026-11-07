import { expect, test } from 'bun:test'
import { decideTriage, type TriageEvidence } from './triage-decision.ts'

const evidence = (
  provenance?: NonNullable<TriageEvidence['reviews'][number]['lenses'][number]['provenance']>,
): TriageEvidence => ({
  patchId: 'patch-a',
  pathSet: '["a.ts"]',
  tip: 'tip-a',
  tier: 1,
  applicableReview: { lenses: ['correctness'] },
  branchOwnerSession: 'owner-session',
  reviews: [
    {
      reviewRecordId: 'review-4',
      reviewNumber: 4,
      recordedAt: '2026-11-06T00:00:00Z',
      completedAt: '2026-11-06T01:00:00Z',
      tier: 1,
      role: 'round',
      patchId: 'patch-a',
      pathSet: '["a.ts"]',
      lensIdentities: ['correctness'],
      lenses: [
        {
          recordId: 'lens-4',
          lens: 'correctness',
          graded: true,
          settled: true,
          ...(provenance ? { provenance } : {}),
        },
      ],
      findings: [],
    },
  ],
  branchReviewGroups: [],
  reads: [],
})

test('triage credits matching lens provenance and legacy rows without provenance', () => {
  const matching = {
    recorded: true,
    treeInspected: '/missing/trees/review',
    runTree: '/missing/trees/review',
    reviewedCommit: 'abcdef1',
    headCommit: 'abcdef1234567890',
  } as const

  expect(decideTriage(evidence(matching))).toMatchObject({ complete: true })
  expect(decideTriage(evidence())).toMatchObject({ complete: true })
})

test('triage leaves a lens owed when its provenance names another tree', () => {
  expect(
    decideTriage(
      evidence({
        recorded: true,
        treeInspected: '/missing/trees/other',
        runTree: '/missing/trees/review',
        reviewedCommit: 'abcdef1',
        headCommit: 'abcdef1234567890',
      }),
    ),
  ).toMatchObject({
    complete: false,
    missingLenses: [{ lens: 'correctness', recordedOnBranch: true, reason: 'tree-mismatch' }],
  })
})

test('an admissible ungraded lens row still counts toward published lens rounds', () => {
  const input = evidence({
    recorded: true,
    treeInspected: '/missing/trees/review',
    runTree: '/missing/trees/review',
    reviewedCommit: 'abcdef1',
    headCommit: 'abcdef1234567890',
  })
  input.reviews[0]!.lenses = [
    {
      ...input.reviews[0]!.lenses[0]!,
      graded: false,
      settled: false,
    },
  ]

  expect(decideTriage(input)).toMatchObject({
    complete: false,
    snapshot: { lensRounds: 1 },
  })
})

test('triage leaves a lens owed when its provenance names another commit', () => {
  expect(
    decideTriage(
      evidence({
        recorded: true,
        treeInspected: '/missing/trees/review',
        runTree: '/missing/trees/review',
        reviewedCommit: '1234567',
        headCommit: 'abcdef1234567890',
      }),
    ),
  ).toMatchObject({
    complete: false,
    missingLenses: [{ lens: 'correctness', recordedOnBranch: true, reason: 'commit-mismatch' }],
  })
})

test('composed coverage reports the mismatch found on an exact completed review', () => {
  const input = evidence({
    recorded: true,
    treeInspected: '/missing/trees/other',
    runTree: '/missing/trees/review',
    reviewedCommit: 'abcdef1',
    headCommit: 'abcdef1234567890',
  })
  input.branchReviewGroups = [
    {
      reviews: [
        {
          ...input.reviews[0]!,
          reviewRecordId: 'review-3',
          reviewNumber: 3,
          patchId: 'older-patch',
          lensIdentities: ['safety'],
          lenses: [
            {
              recordId: 'lens-safety',
              lens: 'safety',
              graded: true,
              settled: true,
            },
          ],
        },
      ],
    },
  ]

  expect(decideTriage(input)).toMatchObject({
    complete: false,
    missingLenses: [{ lens: 'correctness', recordedOnBranch: true, reason: 'tree-mismatch' }],
  })
})

test('triage leaves an inadmissible second-opinion lens owed', () => {
  const input = evidence()
  input.applicableReview = { lenses: ['correctness'], secondOpinion: 'correctness' }
  input.reviews = [
    {
      ...input.reviews[0]!,
      lenses: [
        {
          ...input.reviews[0]!.lenses[0]!,
          runId: 'run-a',
          model: 'model-a',
        },
      ],
    },
    {
      ...input.reviews[0]!,
      reviewRecordId: 'review-5',
      reviewNumber: 5,
      lenses: [
        {
          ...input.reviews[0]!.lenses[0]!,
          recordId: 'lens-5',
          runId: 'run-b',
          model: 'model-b',
          provenance: {
            recorded: true,
            treeInspected: '/missing/trees/other',
            runTree: '/missing/trees/review',
            reviewedCommit: 'abcdef1',
            headCommit: 'abcdef1234567890',
          },
        },
      ],
    },
  ]

  expect(decideTriage(input)).toMatchObject({
    complete: false,
    missingSecondOpinion: { lens: 'correctness', firstRunId: 'run-a' },
  })
})

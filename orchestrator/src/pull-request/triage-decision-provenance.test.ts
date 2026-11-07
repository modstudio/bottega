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
    treeInspected: '/trees/review',
    runTree: '/trees/review',
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
        treeInspected: '/trees/other',
        runTree: '/trees/review',
        reviewedCommit: 'abcdef1',
        headCommit: 'abcdef1234567890',
      }),
    ),
  ).toMatchObject({
    complete: false,
    missingLenses: [{ lens: 'correctness', recordedOnBranch: true, reason: 'tree-mismatch' }],
  })
})

test('triage leaves a lens owed when its provenance names another commit', () => {
  expect(
    decideTriage(
      evidence({
        recorded: true,
        treeInspected: '/trees/review',
        runTree: '/trees/review',
        reviewedCommit: '1234567',
        headCommit: 'abcdef1234567890',
      }),
    ),
  ).toMatchObject({
    complete: false,
    missingLenses: [{ lens: 'correctness', recordedOnBranch: true, reason: 'commit-mismatch' }],
  })
})

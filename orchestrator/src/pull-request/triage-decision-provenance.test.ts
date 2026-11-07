import { expect, test } from 'bun:test'
import {
  decideTriage,
  lensProvenanceSubject,
  type TriageEvidence,
  treeInspectedPath,
} from './triage-decision.ts'

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

test('tree evidence extracts the first qualifying absolute path from recorded review shapes', () => {
  expect(
    treeInspectedPath(
      '/Users/shmuel/Projects/bottega/.claude/worktrees/orch-review-7b49b6460122 (detached worktree at the artifact HEAD)',
    ),
  ).toBe('/Users/shmuel/Projects/bottega/.claude/worktrees/orch-review-7b49b6460122')
  expect(
    treeInspectedPath(
      'base 558e80d; (`/Users/shmuel/Projects/bottega/.claude/worktrees/orch-review-a8d3e4ed17f2`: diff origin/master...HEAD)',
    ),
  ).toBe('/Users/shmuel/Projects/bottega/.claude/worktrees/orch-review-a8d3e4ed17f2')
  expect(treeInspectedPath('74ff6ad...70ba3dd')).toBeNull()
  expect(treeInspectedPath(null)).toBeNull()
})

test('tree admission credits absent claims and paths inside the run tree', () => {
  const commit = { recorded: true, reviewedCommit: 'abcdef1', headCommit: 'abcdef1234567890' }

  expect(
    lensProvenanceSubject({ ...commit, treeInspected: null, runTree: '/missing/trees/review' }),
  ).toEqual({
    admissible: true,
  })
  expect(
    lensProvenanceSubject({
      ...commit,
      treeInspected: '/missing/trees/review/src/nested',
      runTree: '/missing/trees/review',
    }),
  ).toEqual({ admissible: true })
})

test('tree admission refuses a path in another review tree or a named path without a run tree', () => {
  const commit = { recorded: true, reviewedCommit: 'abcdef1', headCommit: 'abcdef1234567890' }

  expect(
    lensProvenanceSubject({
      ...commit,
      treeInspected: '/missing/trees/orch-review-other',
      runTree: '/missing/trees/orch-review-subject',
    }),
  ).toEqual({ admissible: false, reason: 'tree-mismatch' })
  expect(
    lensProvenanceSubject({ ...commit, treeInspected: '/missing/trees/review', runTree: null }),
  ).toEqual({ admissible: false, reason: 'tree-mismatch' })
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

import { expect, test } from 'bun:test'
import {
  type PerPathPatch,
  type RebaseFileComparison,
  postFixReviewDecision,
  rebaseCarryDecision,
} from './review-post-fix.ts'
import { applicableRoundLensPlan } from './review-round-lens-plan.ts'

const patch = (path: string, patchId: string): PerPathPatch => ({
  path,
  patchId,
  insertions: 1,
  deletions: 0,
})
const comparison = (
  path: string,
  replayed: string,
  current: string,
  conflicted = false,
): RebaseFileComparison => ({
  path,
  replayed: patch(path, replayed),
  current: patch(path, current),
  conflicted,
})

test('a clean replay carrying the reviewed content carries every lens', () => {
  expect(
    rebaseCarryDecision({
      files: [comparison('critical/shared.ts', 'same', 'same')],
      pathsByLens: {
        correctness: ['critical/shared.ts'],
        'migration-safety': ['critical/shared.ts'],
      },
    }),
  ).toEqual({ fixFiles: [], reOwedPathsByLens: {} })
})

test('a conflict-resolved file re-owes only lenses that recorded that file', () => {
  expect(
    rebaseCarryDecision({
      files: [comparison('critical/shared.ts', 'merge-result', 'resolved', true)],
      pathsByLens: {
        correctness: ['src/other.ts'],
        'migration-safety': ['critical/shared.ts'],
      },
    }),
  ).toEqual({
    fixFiles: [{ path: 'critical/shared.ts', insertions: 1, deletions: 0 }],
    reOwedPathsByLens: { 'migration-safety': ['critical/shared.ts'] },
  })
})

test('a changed file outside every recorded lens path re-owes no lens', () => {
  expect(
    rebaseCarryDecision({
      files: [comparison('generated/baseline.json', 'old', 'new')],
      pathsByLens: {
        correctness: ['src/app.ts'],
        'migration-safety': ['migrations/001.sql'],
      },
    }),
  ).toEqual({
    fixFiles: [{ path: 'generated/baseline.json', insertions: 1, deletions: 0 }],
    reOwedPathsByLens: {},
  })
})

test('an annotated coverage claim names a differing file', () => {
  expect(
    rebaseCarryDecision({
      files: [comparison('critical/shared.ts', 'old', 'new')],
      pathsByLens: {
        correctness: ['1 of 1 changed files inspected in full: "critical/shared.ts"'],
      },
    }),
  ).toEqual({
    fixFiles: [{ path: 'critical/shared.ts', insertions: 1, deletions: 0 }],
    reOwedPathsByLens: { correctness: ['critical/shared.ts'] },
  })
})

test('a replay difference re-owes a lens even when it reviewed that path before the rebase', () => {
  expect(
    applicableRoundLensPlan({
      relevant: { lenses: ['correctness', 'migration-safety'] },
      facts: {
        reviewedPathsByLens: { 'migration-safety': ['migrations/001.sql'] },
        completedLenses: ['correctness', 'migration-safety'],
        satisfiedSecondOpinionLenses: [],
        latestAcceptedOrModifiedLenses: [],
      },
      postFix: {
        kind: 're-lens',
        reviewNumber: 2,
        reviewedTip: 'recorded-pin',
        fixPaths: ['migrations/001.sql'],
        tierThreePaths: ['migrations/001.sql'],
        applicability: { lenses: ['migration-safety'] },
        reOwedPathsByLens: { 'migration-safety': ['migrations/001.sql'] },
      },
      fixPathsByLens: { 'migration-safety': ['migrations/001.sql'] },
    }).round,
  ).toEqual({
    lenses: ['migration-safety'],
    lensReasons: { 'migration-safety': 'newly-touched-path' },
  })
})

test('a rebase that re-owes one lens off a tier-3 path re-lenses only that lens', () => {
  const decision = postFixReviewDecision({
    facts: {
      completed: {
        number: 1,
        identity: 'review',
        launchKey: 'DEV-1813',
        runIds: [],
        pathsByLens: { correctness: ['src/a.ts'], craft: ['src/b.ts'] },
      },
      reviewedTip: 'reviewed',
      fixFiles: [{ path: 'src/a.ts', insertions: 1, deletions: 1 }],
      reOwedPathsByLens: { correctness: ['src/a.ts'] },
    },
    tier: 3,
    review: undefined,
  })
  expect(decision).toMatchObject({
    kind: 're-lens',
    tierThreePaths: [],
    applicability: { lenses: ['correctness'] },
  })
})

import { expect, test } from 'bun:test'
import type { ReviewSettings } from '../project/project-injection.ts'
import { fixFilesFromPatches, type PerPathPatch, postFixReviewDecision } from './review-post-fix.ts'
import { applicableRoundLensPlan } from './review-round-lens-plan.ts'

const completed = { number: 2, identity: 'reviewed', launchKey: 'AB-3097', runIds: ['run'] }
const patch = (path: string, patchId: string): PerPathPatch => ({
  path,
  patchId,
  insertions: 1,
  deletions: 0,
})
const review: ReviewSettings = {
  lenses: [
    { lens: 'correctness' },
    { lens: 'migration-safety', paths: ['migrations/**', 'critical/**'] },
    { lens: 'craft', paths: ['src/**'] },
  ],
  risk: {
    paths: [
      { pattern: '^(critical|migrations)/', tier: 3, reason: 'composition-sensitive surface' },
    ],
    unlisted: 2,
  },
}

test('a rebase over disjoint trunk work carries an unchanged branch round', () => {
  const fixFiles = fixFilesFromPatches(
    [patch('critical/shared.ts', 'unchanged')],
    [patch('critical/shared.ts', 'unchanged')],
    ['trunk/disjoint.ts'],
  )
  const decision = postFixReviewDecision({
    facts: { completed, reviewedTip: 'recorded-pin', fixFiles },
    tier: 3,
    review,
  })

  expect(decision).toMatchObject({ kind: 'no-round-needed', reviewedTip: 'recorded-pin' })
  expect(
    applicableRoundLensPlan({
      relevant: { lenses: ['correctness', 'migration-safety', 'craft'] },
      facts: {
        reviewedPathsByLens: {},
        completedLenses: ['correctness', 'migration-safety', 'craft'],
        satisfiedSecondOpinionLenses: [],
        latestAcceptedOrModifiedLenses: [],
      },
      postFix: decision,
      fixPathsByLens: {},
    }).round,
  ).toEqual({ lenses: [] })
})
test('a rebase over trunk work on a branch path re-runs only that path lens', () => {
  const fixFiles = fixFilesFromPatches(
    [patch('critical/shared.ts', 'unchanged')],
    [patch('critical/shared.ts', 'unchanged')],
    ['critical/shared.ts'],
  )
  const decision = postFixReviewDecision({
    facts: { completed, reviewedTip: 'recorded-pin', fixFiles },
    tier: 3,
    review,
  })

  expect(decision).toMatchObject({
    kind: 're-lens',
    fixPaths: ['critical/shared.ts'],
    tierThreePaths: ['critical/shared.ts'],
  })
  expect(
    applicableRoundLensPlan({
      relevant: { lenses: ['correctness', 'migration-safety', 'craft'] },
      facts: {
        reviewedPathsByLens: { 'migration-safety': [] },
        completedLenses: ['correctness', 'migration-safety', 'craft'],
        satisfiedSecondOpinionLenses: [],
        latestAcceptedOrModifiedLenses: [],
      },
      postFix: decision,
      fixPathsByLens: {
        'migration-safety': ['critical/shared.ts'],
      },
    }).round,
  ).toEqual({
    lenses: ['migration-safety'],
    lensReasons: { 'migration-safety': 'newly-touched-path' },
  })
})

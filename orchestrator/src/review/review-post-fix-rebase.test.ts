import { expect, test } from 'bun:test'
import {
  decideTriage,
  type TriageEvidence,
} from '../review-funnel/review-funnel-admission-evidence.ts'
import {
  type PerPathPatch,
  postFixReviewDecision,
  type RebaseFileComparison,
  rebaseCarryDecision,
  trunkChangedPathSet,
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
  trunkChanged = false,
): RebaseFileComparison => ({
  path,
  replayed: patch(path, replayed),
  current: patch(path, current),
  conflicted,
  trunkChanged,
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

test('an author fix after the reviewed round is a fix file without re-owing a lens', () => {
  expect(
    rebaseCarryDecision({
      files: [comparison('src/fixed.ts', 'reviewed', 'fixed')],
      pathsByLens: { correctness: ['src/fixed.ts'] },
    }),
  ).toEqual({
    fixFiles: [{ path: 'src/fixed.ts', insertions: 1, deletions: 0 }],
    reOwedPathsByLens: {},
  })
})

test('a trunk-changed file re-owes its covering lens', () => {
  expect(
    rebaseCarryDecision({
      files: [comparison('src/shared.ts', 'reviewed', 'rebased', false, true)],
      pathsByLens: { correctness: ['src/shared.ts'] },
    }),
  ).toEqual({
    fixFiles: [{ path: 'src/shared.ts', insertions: 1, deletions: 0 }],
    reOwedPathsByLens: { correctness: ['src/shared.ts'] },
  })
})

test('a one-to-one rename with identical content is unchanged', () => {
  expect(
    rebaseCarryDecision({
      files: [
        {
          path: 'migrations/old/migration.sql',
          replayed: patch('migrations/old/migration.sql', 'sql-content'),
          current: null,
          conflicted: false,
          trunkChanged: false,
        },
        {
          path: 'migrations/new/migration.sql',
          replayed: null,
          current: patch('migrations/new/migration.sql', 'sql-content'),
          conflicted: false,
          trunkChanged: false,
        },
      ],
      pathsByLens: { 'migration-safety': ['migrations/old/migration.sql'] },
    }),
  ).toEqual({ fixFiles: [], reOwedPathsByLens: {} })
})

test('trunk-changed paths include modifications, additions, and both rename names', () => {
  expect(
    [
      ...trunkChangedPathSet({
        changedPaths: ['src/modified.ts', 'src/renamed.ts', 'src/added.ts'],
        renames: new Map([['src/original.ts', 'src/renamed.ts']]),
      }),
    ].sort(),
  ).toEqual(['src/added.ts', 'src/modified.ts', 'src/original.ts', 'src/renamed.ts'])
})

test('a changed author file outside every recorded lens path re-owes no lens', () => {
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

test('an annotated coverage claim names a trunk-changed differing file', () => {
  expect(
    rebaseCarryDecision({
      files: [comparison('critical/shared.ts', 'old', 'new', false, true)],
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

test('six post-round author fixes after a clean replay need only an architect read', () => {
  const files = [
    'backfill-owner-party.ts',
    'business-account.ts',
    'billing.service.ts',
    'payer.ts',
    'seed-scenarios.service.ts',
    'seed-shared.ts',
  ].map((path) => comparison(`src/${path}`, `reviewed-${path}`, `fixed-${path}`))
  const carry = rebaseCarryDecision({
    files,
    pathsByLens: Object.fromEntries(
      ['correctness', 'craft', 'test-quality'].map((lens) => [lens, files.map(({ path }) => path)]),
    ),
  })
  expect(carry.fixFiles).toHaveLength(6)
  expect(carry.reOwedPathsByLens).toEqual({})
  expect(
    postFixReviewDecision({
      facts: {
        completed: {
          number: 1,
          identity: 'review',
          launchKey: 'STO-1346',
          runIds: [],
          pathsByLens: {},
        },
        reviewedTip: 'reviewed',
        fixFiles: carry.fixFiles,
        reOwedPathsByLens: carry.reOwedPathsByLens,
      },
      tier: 3,
      review: undefined,
    }),
  ).toMatchObject({ kind: 'no-round-needed', tierThreePaths: [] })
})

const completedReview: TriageEvidence['reviews'][number] = {
  reviewRecordId: 'review-1',
  reviewNumber: 1,
  recordedAt: '2026-11-01T00:00:00Z',
  completedAt: '2026-11-01T01:00:00Z',
  tier: 3,
  role: 'round',
  patchId: 'patch-before',
  zeroContextPatchId: 'patch-before',
  pathSet: '["src/a.ts","src/b.ts"]',
  lensIdentities: ['lens-a', 'lens-b'],
  lenses: [
    { recordId: 'lens-a-row', lens: 'lens-a', graded: true, settled: true },
    { recordId: 'lens-b-row', lens: 'lens-b', graded: true, settled: true },
  ],
  findings: [],
}

test.each([
  {
    name: 'an unchanged patch keeps every review',
    files: [comparison('src/a.ts', 'same', 'same')],
    patchId: 'patch-before',
    zeroContextPatchId: 'patch-before',
    exactReviews: [completedReview],
    expectedRound: [],
    expectedComplete: true,
    expectedMissing: [],
  },
  {
    name: 'a conflict resolution reopens only the lens covering its changed file',
    files: [comparison('src/a.ts', 'replayed', 'resolved', true)],
    patchId: 'patch-after-conflict',
    zeroContextPatchId: 'patch-after-conflict',
    exactReviews: [],
    expectedRound: ['lens-a'],
    expectedComplete: false,
    expectedMissing: ['lens-a'],
  },
  {
    name: 'a changed file outside lens coverage reopens no lens',
    files: [comparison('generated/output.json', 'before', 'after')],
    patchId: 'patch-after-uncovered-file',
    zeroContextPatchId: 'patch-after-uncovered-file',
    exactReviews: [],
    expectedRound: [],
    expectedComplete: false,
    expectedMissing: [],
  },
])('$name in both the funnel and admission', (scenario) => {
  const carry = rebaseCarryDecision({
    files: scenario.files,
    pathsByLens: { 'lens-a': ['src/a.ts'], 'lens-b': ['src/b.ts'] },
  })
  const postFix = postFixReviewDecision({
    facts: {
      completed: {
        number: 1,
        identity: 'review-identity',
        launchKey: 'DEV-2258',
        runIds: [],
        pathsByLens: { 'lens-a': ['src/a.ts'], 'lens-b': ['src/b.ts'] },
      },
      reviewedTip: 'tip-before-rebase',
      fixFiles: carry.fixFiles,
      reOwedPathsByLens: carry.reOwedPathsByLens,
    },
    tier: 3,
    review: undefined,
  })
  const relevant = { lenses: ['lens-a', 'lens-b'] }
  const reviewPlan = applicableRoundLensPlan({
    relevant,
    facts: {
      reviewedPathsByLens: { 'lens-a': ['src/a.ts'], 'lens-b': ['src/b.ts'] },
      completedLenses: ['lens-a', 'lens-b'],
      satisfiedSecondOpinionLenses: [],
      latestAcceptedOrModifiedLenses: [],
    },
    postFix,
    fixPathsByLens: carry.reOwedPathsByLens,
  })
  expect(reviewPlan.round.lenses).toEqual([...scenario.expectedRound])

  const triage = decideTriage({
    patchId: scenario.patchId,
    zeroContextPatchId: scenario.patchId,
    pathSet: '["src/a.ts","src/b.ts"]',
    tier: 3,
    applicableReview: relevant,
    reviewPlan,
    branchOwnerSession: 'owner-session',
    reviews: scenario.exactReviews,
    branchReviewGroups: [{ reviews: [completedReview] }],
    reads: [],
  })
  expect(triage.complete).toBe(scenario.expectedComplete)
  expect(triage.complete ? [] : triage.missingLenses.map(({ lens }) => lens)).toEqual([
    ...scenario.expectedMissing,
  ])
})

import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { decideReviewFunnel, type ReviewFunnelFacts } from './decide-review-funnel.ts'
import { DEFAULT_REVIEW_FUNNEL_POLICY } from './review-funnel-policy.ts'
import { replayReviewFunnelRows } from './review-funnel-replay.ts'

test('replaying logged facts through the active policy reports zero diffs', () => {
  const facts: ReviewFunnelFacts = {
    stack: 'typescript',
    change: {
      project: PLATFORM_SLUG,
      taskKey: 'DEV-2299',
      branch: 'fixture',
      head: 'head',
      patchId: 'patch',
      pathSet: '["src/new.ts"]',
      paths: ['src/new.ts'],
    },
    files: [{ path: 'src/new.ts', insertions: 1, deletions: 0 }],
    review: {
      risk: { unlisted: 2, paths: [{ pattern: '^src/', tier: 1, reason: 'ordinary', firm: true }] },
      lenses: [{ lens: 'correctness' }],
    },
    branchReviews: [],
    postFix: { completed: null },
    rounds: [],
    currentRoundIdentity: 'round',
    lensStates: [],
    exactRead: false,
    readCreditsRound: false,
    ceilingRuling: false,
    overriddenLenses: [],
    triageComplete: false,
    admissionGap: {
      unfinishedReviewNumbers: [],
      undisposedFindings: [],
      missingLenses: ['correctness'],
      architectReadRequired: false,
      nonLensGaps: [],
    },
    yieldCells: [],
  }
  const verdict = decideReviewFunnel(facts, DEFAULT_REVIEW_FUNNEL_POLICY, 'builtin')
  expect(
    replayReviewFunnelRows([{ recordId: 'decision', facts, verdict }], {
      policy: DEFAULT_REVIEW_FUNNEL_POLICY,
      policyVersion: 'builtin',
    }),
  ).toEqual({ diffs: [], selectionNotExercised: [] })
})

test('replay reports an evaluate verdict changed by enforced yield selection', () => {
  const facts: ReviewFunnelFacts = {
    stack: 'typescript',
    change: {
      project: PLATFORM_SLUG,
      taskKey: 'DEV-2303',
      branch: 'yield-fixture',
      head: 'head',
      patchId: 'patch',
      pathSet: '["src/new.ts"]',
      paths: ['src/new.ts'],
    },
    files: [{ path: 'src/new.ts', insertions: 1, deletions: 0 }],
    review: {
      risk: { unlisted: 2, paths: [{ pattern: '^src/', tier: 1, reason: 'ordinary', firm: true }] },
      lenses: [{ lens: 'correctness' }],
    },
    branchReviews: [],
    postFix: { completed: null },
    rounds: [],
    currentRoundIdentity: 'round',
    lensStates: [],
    exactRead: false,
    readCreditsRound: false,
    ceilingRuling: false,
    overriddenLenses: [],
    triageComplete: false,
    admissionGap: {
      unfinishedReviewNumbers: [],
      undisposedFindings: [],
      missingLenses: ['correctness'],
      architectReadRequired: false,
      nonLensGaps: [],
    },
    yieldCells: [
      {
        lens: 'correctness',
        stack: 'typescript',
        tier: 1,
        accepted: 0,
        unique: 0,
        triaged: 5,
      },
    ],
  }
  const evaluatePolicy = {
    ...DEFAULT_REVIEW_FUNNEL_POLICY,
    selection: { ...DEFAULT_REVIEW_FUNNEL_POLICY.selection, pinned: [], explorationShare: 0 },
  }
  const enforcePolicy = {
    ...evaluatePolicy,
    modes: { ...evaluatePolicy.modes, selection: 'enforce' as const },
  }
  const verdict = decideReviewFunnel(facts, evaluatePolicy, 'evaluate')
  const replay = replayReviewFunnelRows([{ recordId: 'yield-decision', facts, verdict }], {
    policy: enforcePolicy,
    policyVersion: 'enforce',
  })

  expect(replay.diffs.map(({ recordId }) => recordId)).toEqual(['yield-decision'])
  expect(replay.selectionNotExercised).toEqual([])
})

test('replay names logged rows whose facts lack selection evidence', () => {
  const facts: ReviewFunnelFacts = {
    stack: null,
    change: {
      project: PLATFORM_SLUG,
      taskKey: null,
      branch: 'legacy',
      head: 'head',
      patchId: 'patch',
      pathSet: '[]',
      paths: [],
    },
    files: [],
    review: undefined,
    branchReviews: [],
    postFix: { completed: null },
    rounds: [],
    currentRoundIdentity: null,
    lensStates: [],
    exactRead: true,
    readCreditsRound: false,
    ceilingRuling: false,
    overriddenLenses: [],
    triageComplete: true,
    admissionGap: {
      unfinishedReviewNumbers: [],
      undisposedFindings: [],
      missingLenses: [],
      architectReadRequired: false,
      nonLensGaps: [],
    },
  }
  const verdict = decideReviewFunnel(facts, DEFAULT_REVIEW_FUNNEL_POLICY, 'builtin')
  expect(
    replayReviewFunnelRows([{ recordId: 'legacy-decision', facts, verdict }], {
      policy: DEFAULT_REVIEW_FUNNEL_POLICY,
      policyVersion: 'builtin',
    }),
  ).toEqual({ diffs: [], selectionNotExercised: ['legacy-decision'] })
})

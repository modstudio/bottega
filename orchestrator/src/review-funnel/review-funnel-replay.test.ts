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
  }
  const verdict = decideReviewFunnel(facts, DEFAULT_REVIEW_FUNNEL_POLICY, 'builtin')
  expect(
    replayReviewFunnelRows([{ recordId: 'decision', facts, verdict }], {
      policy: DEFAULT_REVIEW_FUNNEL_POLICY,
      policyVersion: 'builtin',
    }),
  ).toEqual([])
})

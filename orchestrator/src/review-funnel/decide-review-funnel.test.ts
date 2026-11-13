import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { TriageReviewRow } from '../review/review-group.ts'
import { decideReviewFunnel, type ReviewFunnelFacts } from './decide-review-funnel.ts'
import { DEFAULT_REVIEW_FUNNEL_POLICY } from './review-funnel-policy.ts'

const completedReview = (lens = 'correctness'): TriageReviewRow => ({
  reviewRecordId: 'review-prior',
  reviewNumber: 1,
  recordedAt: '2026-11-13T10:00:00Z',
  completedAt: '2026-11-13T10:05:00Z',
  tier: 3,
  role: 'round',
  patchId: 'prior-patch',
  pathSet: '["src/old.ts"]',
  lensIdentities: [lens],
  lenses: [
    {
      recordId: `lens-${lens}`,
      runId: `run-${lens}`,
      lens,
      model: 'fixture',
      graded: true,
      settled: true,
      provenance: {
        recorded: false,
        treeInspected: null,
        runTree: null,
        reviewedCommit: null,
        headCommit: null,
      },
    },
  ],
  findings: [],
})

const facts = (overrides: Partial<ReviewFunnelFacts> = {}): ReviewFunnelFacts => ({
  change: {
    project: PLATFORM_SLUG,
    taskKey: 'DEV-2300',
    branch: 'DEV-2300-fixture',
    head: 'abc1234',
    patchId: 'current-patch',
    paths: ['src/new.ts'],
  },
  files: [{ path: 'src/new.ts', insertions: 500, deletions: 0 }],
  review: {
    risk: {
      unlisted: 2,
      paths: [{ pattern: '^src/', tier: 3, reason: 'core', firm: true }],
    },
    lenses: [{ lens: 'correctness' }, { lens: 'craft', paths: ['src/**'] }],
  },
  branchReviews: [],
  postFix: { completed: null },
  rounds: [],
  currentRoundIdentity: 'current-round',
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
  ...overrides,
})

const tierOneReview: ReviewFunnelFacts['review'] = {
  risk: {
    unlisted: 2,
    paths: [{ pattern: '^src/', tier: 1, reason: 'ordinary', firm: true }],
  },
  lenses: [{ lens: 'correctness' }],
}

describe('decideReviewFunnel', () => {
  test('the owed admission set is completed lenses union this round lenses', () => {
    const verdict = decideReviewFunnel(
      facts({
        branchReviews: [completedReview()],
        postFix: {
          completed: {
            number: 1,
            identity: 'prior-round',
            launchKey: null,
            runIds: ['run-correctness'],
            pathsByLens: { correctness: ['src/old.ts'] },
          },
          reviewedTip: 'prior-tip',
          fixFiles: [{ path: 'src/new.ts', insertions: 1, deletions: 0 }],
        },
      }),
      DEFAULT_REVIEW_FUNNEL_POLICY,
    )
    expect(
      verdict.lenses
        .filter(({ status }) => status === 'satisfied' || status === 'owed')
        .map(({ lens }) => lens),
    ).toEqual(['correctness', 'craft'])
  })

  test('a round admitted to a landed pull request does not spend the new change budget', () => {
    const verdict = decideReviewFunnel(
      facts({
        files: [{ path: 'src/new.ts', insertions: 11, deletions: 0 }],
        review: tierOneReview,
        rounds: [
          {
            reviewRecordId: 'landed-review',
            identity: 'landed-round',
            provenance: {
              recorded: false,
              treeInspected: null,
              runTree: null,
              reviewedCommit: null,
              headCommit: null,
            },
            landed: true,
          },
        ],
      }),
      DEFAULT_REVIEW_FUNNEL_POLICY,
    )
    expect(verdict.budget.roundsUsed).toBe(0)
    expect(verdict.next.action).toBe('dispatch')
  })

  test('at ceiling asks for a ruling instead of dispatching another round', () => {
    const verdict = decideReviewFunnel(
      facts({
        files: [{ path: 'src/new.ts', insertions: 11, deletions: 0 }],
        review: tierOneReview,
        rounds: [
          {
            reviewRecordId: 'prior-review',
            identity: 'prior-round',
            provenance: {
              recorded: false,
              treeInspected: null,
              runTree: null,
              reviewedCommit: null,
              headCommit: null,
            },
            landed: false,
          },
        ],
      }),
      DEFAULT_REVIEW_FUNNEL_POLICY,
    )
    expect(verdict.budget).toMatchObject({ roundsUsed: 1, ceiling: 1, atCeiling: true })
    expect(verdict.next.action).toBe('ask-ceiling-ruling')
    expect(verdict.lenses.find(({ lens }) => lens === 'correctness')?.status).toBe(
      'waived-at-ceiling',
    )
    expect(verdict.lenses.find(({ lens }) => lens === 'correctness')?.reason).toBe(
      'waived-at-ceiling',
    )
  })

  test('post-fix carry keeps covered lenses satisfied and a changed covered file drops credit', () => {
    const base = facts({
      branchReviews: [completedReview()],
      postFix: {
        completed: {
          number: 1,
          identity: 'prior-round',
          launchKey: null,
          runIds: ['run-correctness'],
          pathsByLens: { correctness: ['src/new.ts'] },
        },
        reviewedTip: 'prior-tip',
        fixFiles: [],
      },
    })
    const carried = decideReviewFunnel(base, DEFAULT_REVIEW_FUNNEL_POLICY)
    const dropped = decideReviewFunnel(
      {
        ...base,
        postFix: {
          ...base.postFix,
          fixFiles: [{ path: 'src/new.ts', insertions: 1, deletions: 0 }],
          reOwedPathsByLens: { correctness: ['src/new.ts'] },
        },
      },
      DEFAULT_REVIEW_FUNNEL_POLICY,
    )
    expect(carried.lenses.find(({ lens }) => lens === 'correctness')?.status).toBe('satisfied')
    expect(dropped.lenses.find(({ lens }) => lens === 'correctness')).toMatchObject({
      status: 'owed',
      reason: 'rebase-changed-file',
    })
  })

  test('an exact architect read credits ceiling work', () => {
    const verdict = decideReviewFunnel(
      facts({
        files: [{ path: 'src/new.ts', insertions: 11, deletions: 0 }],
        review: tierOneReview,
        exactRead: true,
        readCreditsRound: true,
        triageComplete: true,
        rounds: [
          {
            reviewRecordId: 'prior-review',
            identity: 'prior-round',
            provenance: {
              recorded: false,
              treeInspected: null,
              runTree: null,
              reviewedCommit: null,
              headCommit: null,
            },
            landed: false,
          },
        ],
      }),
      DEFAULT_REVIEW_FUNNEL_POLICY,
    )
    expect(verdict.lenses.find(({ lens }) => lens === 'correctness')?.status).toBe(
      'credited-by-read',
    )
    expect(verdict.next.action).toBe('admit')
  })

  test('a running lens waits for its existing run', () => {
    const verdict = decideReviewFunnel(
      facts({
        review: tierOneReview,
        lensStates: [{ lens: 'correctness', runId: 'run-live', state: 'running' }],
      }),
      DEFAULT_REVIEW_FUNNEL_POLICY,
    )
    expect(verdict.lenses.find(({ lens }) => lens === 'correctness')?.status).toBe('running')
    expect(verdict.next.action).toBe('wait')
    expect(verdict.remedy).toBe(`${PLATFORM_SLUG} run wait run-live`)
  })

  test('an untriaged lens asks to score its existing run', () => {
    const verdict = decideReviewFunnel(
      facts({
        review: tierOneReview,
        lensStates: [{ lens: 'correctness', runId: 'run-untriaged', state: 'untriaged' }],
      }),
      DEFAULT_REVIEW_FUNNEL_POLICY,
    )
    expect(verdict.lenses.find(({ lens }) => lens === 'correctness')?.status).toBe('untriaged')
    expect(verdict.next.action).toBe('triage')
    expect(verdict.remedy).toBe(`${PLATFORM_SLUG} score run-untriaged ...`)
  })

  test('an overridden lens is not dispatched', () => {
    const verdict = decideReviewFunnel(
      facts({ review: tierOneReview, overriddenLenses: ['correctness'] }),
      DEFAULT_REVIEW_FUNNEL_POLICY,
    )
    expect(verdict.lenses.find(({ lens }) => lens === 'correctness')).toMatchObject({
      status: 'overridden',
      reason: 'overridden',
    })
    expect(verdict.next.lenses ?? []).not.toContain('correctness')
  })

  test('DEV-2250: complete triage at the ceiling admits without asking for a ruling', () => {
    const verdict = decideReviewFunnel(
      facts({
        files: [{ path: 'src/new.ts', insertions: 11, deletions: 0 }],
        review: tierOneReview,
        triageComplete: true,
        admissionGap: {
          unfinishedReviewNumbers: [],
          undisposedFindings: [],
          missingLenses: [],
          architectReadRequired: false,
          nonLensGaps: [],
        },
        rounds: [
          {
            reviewRecordId: 'prior-review',
            identity: 'prior-round',
            provenance: {
              recorded: false,
              treeInspected: null,
              runTree: null,
              reviewedCommit: null,
              headCommit: null,
            },
            landed: false,
          },
        ],
      }),
      DEFAULT_REVIEW_FUNNEL_POLICY,
    )
    expect(verdict.next.action).toBe('admit')
    expect(verdict.remedy).toBe(`${PLATFORM_SLUG} pr create`)
  })

  test('a recorded ceiling ruling clears the remaining ceiling gap', () => {
    const verdict = decideReviewFunnel(
      facts({
        files: [{ path: 'src/new.ts', insertions: 11, deletions: 0 }],
        review: tierOneReview,
        ceilingRuling: true,
        rounds: [
          {
            reviewRecordId: 'prior-review',
            identity: 'prior-round',
            provenance: {
              recorded: false,
              treeInspected: null,
              runTree: null,
              reviewedCommit: null,
              headCommit: null,
            },
            landed: false,
          },
        ],
      }),
      DEFAULT_REVIEW_FUNNEL_POLICY,
    )
    expect(verdict.next.action).toBe('admit')
    expect(verdict.remedy).toBe(`${PLATFORM_SLUG} pr create`)
  })

  test('DEV-2075: a test-only fix leaves only unrecorded admitted lenses owed', () => {
    const admittedLenses = ['correctness', 'craft', 'security', 'performance']
    const verdict = decideReviewFunnel(
      facts({
        review: {
          ...facts().review,
          lenses: admittedLenses.map((lens) => ({ lens, paths: ['src/**'] })),
        },
        branchReviews: [completedReview('correctness'), completedReview('craft')].map((review) => ({
          ...review,
          lensIdentities: admittedLenses,
        })),
        postFix: {
          completed: {
            number: 1,
            identity: 'prior-round',
            launchKey: null,
            runIds: ['run-correctness', 'run-craft'],
            pathsByLens: {
              correctness: ['src/new.ts'],
              craft: ['src/new.ts'],
              security: ['src/new.ts'],
              performance: ['src/new.ts'],
            },
          },
          reviewedTip: 'prior-tip',
          fixFiles: [{ path: 'src/new.test.ts', insertions: 1, deletions: 0 }],
        },
      }),
      DEFAULT_REVIEW_FUNNEL_POLICY,
    )
    expect(verdict.next).toEqual({ action: 'dispatch', lenses: ['security', 'performance'] })
  })
})

import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { TriageReviewRow } from '../review/review-group.ts'
import type { PerPathPatch } from '../review/review-post-fix.ts'
import { decideReviewFunnel, type ReviewFunnelFacts } from './decide-review-funnel.ts'
import { DEFAULT_REVIEW_FUNNEL_POLICY } from './review-funnel-policy.ts'

const patch = (path: string, patchId: string): PerPathPatch => ({
  path,
  patchId,
  insertions: 1,
  deletions: 0,
})

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
  })

  test('rebase carry keeps covered lenses satisfied and a changed covered file drops credit', () => {
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
    const carried = decideReviewFunnel(
      {
        ...base,
        rebase: {
          files: [
            {
              path: 'src/new.ts',
              replayed: patch('src/new.ts', 'same'),
              current: patch('src/new.ts', 'same'),
              conflicted: false,
            },
          ],
          pathsByLens: { correctness: ['src/new.ts'] },
        },
      },
      DEFAULT_REVIEW_FUNNEL_POLICY,
    )
    const dropped = decideReviewFunnel(
      {
        ...base,
        rebase: {
          files: [
            {
              path: 'src/new.ts',
              replayed: patch('src/new.ts', 'before'),
              current: patch('src/new.ts', 'after'),
              conflicted: true,
            },
          ],
          pathsByLens: { correctness: ['src/new.ts'] },
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
})

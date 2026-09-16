import { describe, expect, test } from 'bun:test'
import {
  type BranchLanding,
  decideBranchState,
  decidePruneEligibility,
  type MergedPullRequest,
} from './branch-state.ts'

const pullRequest: MergedPullRequest = {
  number: 42,
  headRefName: 'DEV-616-orch-4235',
  mergeCommit: { oid: 'abc123' },
  mergedAt: '2026-09-16T12:00:00Z',
}

function decide(overrides: Partial<Parameters<typeof decideBranchState>[0]> = {}) {
  return decideBranchState({
    branch: pullRequest.headRefName,
    mergedPullRequests: [],
    mergedPullRequestsTruncated: false,
    commitsNotOnTrunk: 1,
    patchEquivalent: null,
    contained: false,
    recordedLanding: null,
    laterTurnBranches: [],
    superseded: false,
    ...overrides,
  })
}

describe('run branch state decision', () => {
  test('PR landing precedence mutation: landed by PR beats superseded', () => {
    expect(decide({ mergedPullRequests: [pullRequest], superseded: true })).toEqual({
      state: 'landed',
      landedBy: {
        type: 'pr',
        number: 42,
        mergeCommit: 'abc123',
        mergedAt: '2026-09-16T12:00:00Z',
      },
    })
  })

  test('patch landing precedence mutation: patch equivalence beats superseded without a PR', () => {
    expect(decide({ patchEquivalent: 'commits', superseded: true })).toEqual({
      state: 'landed',
      landedBy: { type: 'patch-equivalent', form: 'commits' },
    })
  })

  test('content containment lands a branch', () => {
    expect(decide({ contained: true })).toEqual({
      state: 'landed',
      landedBy: { type: 'contained' },
    })
  })

  test('a recorded landing wins over content containment', () => {
    expect(
      decide({
        contained: true,
        recordedLanding: {
          number: 190,
          mergeCommit: 'abc123',
          mergedAt: '2026-09-16T12:00:00Z',
        },
      }),
    ).toEqual({
      state: 'landed',
      landedBy: {
        type: 'recorded',
        number: 190,
        mergeCommit: 'abc123',
        mergedAt: '2026-09-16T12:00:00Z',
      },
    })
  })

  test('failed content containment leaves an otherwise unmatched branch unlanded', () => {
    expect(decide({ contained: false })).toEqual({ state: 'unlanded' })
  })

  test('turn landing mutation: a later landed turn lands the earlier branch', () => {
    expect(
      decide({
        laterTurnBranches: [
          {
            branch: 'DEV-616-orch-4240',
            state: {
              state: 'landed',
              landedBy: { type: 'patch-equivalent', form: 'squash' },
            },
          },
        ],
      }),
    ).toEqual({
      state: 'landed',
      landedBy: { type: 'turn', branch: 'DEV-616-orch-4240' },
    })
  })

  test('turn false-positive mutation: a later unlanded turn leaves the earlier branch unlanded', () => {
    expect(
      decide({
        laterTurnBranches: [{ branch: 'DEV-616-orch-4240', state: { state: 'unlanded' } }],
      }),
    ).toEqual({ state: 'unlanded' })
  })

  test('turn precedence mutation: patch equivalence beats a later landed turn', () => {
    expect(
      decide({
        patchEquivalent: 'commits',
        laterTurnBranches: [
          {
            branch: 'DEV-616-orch-4240',
            state: {
              state: 'landed',
              landedBy: {
                type: 'pr',
                number: 43,
                mergeCommit: null,
                mergedAt: '2026-09-16T13:00:00Z',
              },
            },
          },
        ],
      }),
    ).toEqual({
      state: 'landed',
      landedBy: { type: 'patch-equivalent', form: 'commits' },
    })
  })

  test('turn order mutation: a matching PR beats a later landed turn', () => {
    expect(
      decide({
        mergedPullRequests: [pullRequest],
        laterTurnBranches: [
          {
            branch: 'DEV-616-orch-4240',
            state: {
              state: 'landed',
              landedBy: { type: 'patch-equivalent', form: 'commits' },
            },
          },
        ],
      }),
    ).toMatchObject({ state: 'landed', landedBy: { type: 'pr' } })
  })

  test('turn order mutation: empty beats a later landed turn', () => {
    expect(
      decide({
        commitsNotOnTrunk: 0,
        laterTurnBranches: [
          {
            branch: 'DEV-616-orch-4240',
            state: {
              state: 'landed',
              landedBy: { type: 'patch-equivalent', form: 'commits' },
            },
          },
        ],
      }),
    ).toEqual({ state: 'empty' })
  })

  test('landing signal order mutation: a matching PR wins over patch equivalence', () => {
    expect(decide({ mergedPullRequests: [pullRequest], patchEquivalent: 'squash' })).toMatchObject({
      state: 'landed',
      landedBy: { type: 'pr' },
    })
  })

  test('empty precedence mutation: empty beats patch equivalence', () => {
    expect(decide({ commitsNotOnTrunk: 0, patchEquivalent: 'commits' })).toEqual({
      state: 'empty',
    })
  })

  test('PR proof precedence mutation: a matching PR beats empty', () => {
    expect(decide({ mergedPullRequests: [pullRequest], commitsNotOnTrunk: 0 })).toMatchObject({
      state: 'landed',
      landedBy: { type: 'pr' },
    })
  })

  test('supersession fallback mutation: an unmatched superseded branch is superseded', () => {
    expect(decide({ superseded: true })).toEqual({ state: 'superseded' })
  })

  test('complete-history fallback mutation: an unmatched branch is unlanded', () => {
    expect(decide()).toEqual({ state: 'unlanded' })
  })

  test('truncation safety mutation: an unmatched branch is unknown when the PR list is capped', () => {
    expect(decide({ mergedPullRequestsTruncated: true })).toEqual({
      state: 'unknown',
    })
  })

  test('truncated-match mutation: a matching PR remains landed when the PR list is capped', () => {
    expect(
      decide({
        mergedPullRequests: [pullRequest],
        mergedPullRequestsTruncated: true,
      }),
    ).toMatchObject({ state: 'landed', landedBy: { type: 'pr' } })
  })
})

describe('branch prune eligibility decision', () => {
  const states: BranchLanding['state'][] = ['landed', 'empty', 'superseded', 'unlanded', 'unknown']
  for (const state of states) {
    for (const checkedOut of [false, true]) {
      for (const liveRun of [false, true]) {
        for (const tipMoved of [false, true]) {
          test(`prune guard mutation: ${state}, checked-out=${checkedOut}, live=${liveRun}, tip-moved=${tipMoved}`, () => {
            const result = decidePruneEligibility({
              state,
              checkedOut,
              liveRun,
              tipMoved,
            })
            expect(result.eligible).toBe(
              ['landed', 'empty', 'superseded'].includes(state) &&
                !checkedOut &&
                !liveRun &&
                !tipMoved,
            )
          })
        }
      }
    }
  }
})

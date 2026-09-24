import { describe, expect, test } from 'bun:test'
import {
  type BranchLanding,
  decideBranchState,
  decideProtectedBranch,
  decidePruneEligibility,
  findRecordedBranchLanding,
  pullRequestCarriesKey,
} from './branch-state.ts'
import type { MergedPullRequest } from './merged-pull-request.ts'

describe('protected project branch decision', () => {
  test('trunk protection mutation: refuses the registered trunk', () => {
    expect(
      decideProtectedBranch({ branch: 'develop', trunk: 'develop', productionBranch: 'main' }),
    ).toBe('trunk')
  })

  test('production protection mutation: refuses the registered production branch', () => {
    expect(
      decideProtectedBranch({ branch: 'main', trunk: 'develop', productionBranch: 'main' }),
    ).toBe('production')
  })

  test('ordinary branch mutation: allows a run branch', () => {
    expect(
      decideProtectedBranch({
        branch: 'DEV-616-orch-4346',
        trunk: 'develop',
        productionBranch: 'main',
      }),
    ).toBeNull()
  })
})

const pullRequest: MergedPullRequest = {
  number: 42,
  state: 'MERGED',
  headRefName: 'DEV-616-orch-4235',
  headRefOid: 'def456',
  title: 'DEV-616: branch recognition',
  mergeCommit: { oid: 'abc123' },
  mergedAt: '2026-09-16T12:00:00Z',
}

const recordedLanding = {
  tip: 'def456',
  number: 190,
  mergeCommit: 'abc123',
  mergedAt: '2026-09-16T12:00:00Z',
}

function decide(overrides: Partial<Parameters<typeof decideBranchState>[0]> = {}) {
  return decideBranchState({
    branch: pullRequest.headRefName,
    tip: 'def456',
    mergedPullRequests: [],
    mergedPullRequestsTruncated: false,
    commitsNotOnTrunk: 1,
    patchEquivalent: null,
    pullRequestCommitCheck: null,
    recordedLanding: null,
    laterTurnBranches: [],
    superseded: false,
    ...overrides,
  })
}

describe('pull request task-key matching', () => {
  test('head token mutation: recognizes a key token in the head branch', () => {
    expect(
      pullRequestCarriesKey({ headRefName: 'DEV-616-ship', title: 'Ship work' }, 'DEV-616'),
    ).toBe(true)
  })

  test('title token mutation: recognizes a key token in the title', () => {
    expect(
      pullRequestCarriesKey({ headRefName: 'release', title: 'Ship DEV-616 now' }, 'DEV-616'),
    ).toBe(true)
  })

  test('prefix mutation: does not mistake a longer key for the requested key', () => {
    expect(pullRequestCarriesKey(pullRequest, 'DEV-61')).toBe(false)
  })
})

describe('recorded branch landing lookup', () => {
  test('project identity mutation: a record from another project does not apply', () => {
    expect(
      findRecordedBranchLanding(
        [
          {
            project: 'other',
            branch: pullRequest.headRefName,
            ...recordedLanding,
          },
        ],
        'alpha',
        pullRequest.headRefName,
      ),
    ).toBeNull()
  })
})

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

  test('recorded landing tip mutation: a matching tip is landed by the record', () => {
    expect(decide({ recordedLanding })).toEqual({
      state: 'landed',
      landedBy: {
        type: 'recorded',
        number: 190,
        mergeCommit: 'abc123',
        mergedAt: '2026-09-16T12:00:00Z',
      },
    })
  })

  test('recorded landing stale mutation: a different tip falls through to the next route', () => {
    expect(decide({ recordedLanding, patchEquivalent: 'commits', tip: 'advanced789' })).toEqual({
      state: 'landed',
      landedBy: { type: 'patch-equivalent', form: 'commits' },
      note: 'recorded landing stale (branch advanced)',
    })
  })

  test('recorded landing precedence mutation: a matching PR beats a recorded landing', () => {
    expect(decide({ mergedPullRequests: [pullRequest], recordedLanding })).toMatchObject({
      state: 'landed',
      landedBy: { type: 'pr' },
    })
  })

  test('recorded landing empty precedence mutation: recorded beats empty', () => {
    expect(decide({ commitsNotOnTrunk: 0, recordedLanding })).toEqual({
      state: 'landed',
      landedBy: {
        type: 'recorded',
        number: 190,
        mergeCommit: 'abc123',
        mergedAt: '2026-09-16T12:00:00Z',
      },
    })
  })

  test('recorded landing patch precedence mutation: recorded beats patch equivalence', () => {
    expect(decide({ patchEquivalent: 'commits', recordedLanding })).toEqual({
      state: 'landed',
      landedBy: {
        type: 'recorded',
        number: 190,
        mergeCommit: 'abc123',
        mergedAt: '2026-09-16T12:00:00Z',
      },
    })
  })

  test('recorded landing PR commits precedence mutation: recorded beats a commit match', () => {
    expect(decide({ pullRequestCommitCheck: { number: 43 }, recordedLanding })).toEqual({
      state: 'landed',
      landedBy: {
        type: 'recorded',
        number: 190,
        mergeCommit: 'abc123',
        mergedAt: '2026-09-16T12:00:00Z',
      },
    })
  })

  test('recorded landing turn precedence mutation: recorded beats a later landed turn', () => {
    expect(
      decide({
        recordedLanding,
        laterTurnBranches: [
          {
            branch: 'DEV-616-orch-4240',
            state: { state: 'landed', landedBy: { type: 'patch-equivalent', form: 'commits' } },
          },
        ],
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

  test('recorded landing superseded precedence mutation: recorded beats superseded', () => {
    expect(decide({ recordedLanding, superseded: true })).toEqual({
      state: 'landed',
      landedBy: {
        type: 'recorded',
        number: 190,
        mergeCommit: 'abc123',
        mergedAt: '2026-09-16T12:00:00Z',
      },
    })
  })

  test('turn landing mutation: a later landed turn lands the earlier branch', () => {
    expect(
      decide({
        laterTurnBranches: [
          {
            branch: 'DEV-616-orch-4240',
            state: { state: 'landed', landedBy: { type: 'patch-equivalent', form: 'squash' } },
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
    ).toEqual({ state: 'landed', landedBy: { type: 'patch-equivalent', form: 'commits' } })
  })

  test('turn order mutation: a matching PR beats a later landed turn', () => {
    expect(
      decide({
        mergedPullRequests: [pullRequest],
        laterTurnBranches: [
          {
            branch: 'DEV-616-orch-4240',
            state: { state: 'landed', landedBy: { type: 'patch-equivalent', form: 'commits' } },
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
            state: { state: 'landed', landedBy: { type: 'patch-equivalent', form: 'commits' } },
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

  test('PR commits precedence mutation: a PR-name match beats a commit match', () => {
    expect(
      decide({ mergedPullRequests: [pullRequest], pullRequestCommitCheck: { number: 43 } }),
    ).toMatchObject({ landedBy: { type: 'pr', number: 42 } })
  })

  test('PR commits empty precedence mutation: empty beats a commit match', () => {
    expect(decide({ commitsNotOnTrunk: 0, pullRequestCommitCheck: { number: 43 } })).toEqual({
      state: 'empty',
    })
  })

  test('PR commits patch precedence mutation: patch equivalence beats a commit match', () => {
    expect(decide({ patchEquivalent: 'commits', pullRequestCommitCheck: { number: 43 } })).toEqual({
      state: 'landed',
      landedBy: { type: 'patch-equivalent', form: 'commits' },
    })
  })

  test('PR commits turn precedence mutation: a commit match beats a later landed turn', () => {
    expect(
      decide({
        pullRequestCommitCheck: { number: 43 },
        laterTurnBranches: [
          {
            branch: 'DEV-616-orch-4240',
            state: { state: 'landed', landedBy: { type: 'patch-equivalent', form: 'commits' } },
          },
        ],
      }),
    ).toEqual({ state: 'landed', landedBy: { type: 'pr-commits', number: 43 } })
  })

  test('PR commits superseded precedence mutation: a commit match beats supersession', () => {
    expect(decide({ pullRequestCommitCheck: { number: 43 }, superseded: true })).toEqual({
      state: 'landed',
      landedBy: { type: 'pr-commits', number: 43 },
    })
  })

  test('turn PR commits mutation: a later turn landed by PR commits lands the earlier branch', () => {
    expect(
      decide({
        laterTurnBranches: [
          {
            branch: 'DEV-616-orch-4240',
            state: { state: 'landed', landedBy: { type: 'pr-commits', number: 43 } },
          },
        ],
      }),
    ).toEqual({ state: 'landed', landedBy: { type: 'turn', branch: 'DEV-616-orch-4240' } })
  })

  test('PR check failure mutation: a failed check makes the branch unknown', () => {
    expect(decide({ pullRequestCommitCheck: { error: 'fetch refused' } })).toEqual({
      state: 'unknown',
      error: 'fetch refused',
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
    expect(decide({ mergedPullRequestsTruncated: true })).toEqual({ state: 'unknown' })
  })

  test('truncated-match mutation: a matching PR remains landed when the PR list is capped', () => {
    expect(
      decide({ mergedPullRequests: [pullRequest], mergedPullRequestsTruncated: true }),
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
            const result = decidePruneEligibility({ state, checkedOut, liveRun, tipMoved })
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

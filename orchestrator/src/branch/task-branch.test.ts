import { describe, expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import {
  GH_TARGETED_MERGED_PR_LIMIT,
  type GitHubPullRequest,
  pullRequestListing,
} from './merged-pull-request.ts'
import {
  decideTaskBranchLanding,
  decideTaskBranchPullRequestCheck,
  isTaskBranchSuperseded,
  type TaskBranchRunRow,
  taskBranchCandidacySql,
  taskBranchLandingRefusalMessage,
  taskBranchReuseNotice,
} from './task-branch.ts'

const row = (
  id: number,
  branch: string,
  launchBase: string | null,
  parentRunId: number | null = null,
): TaskBranchRunRow => ({
  id,
  parent_run_id: parentRunId,
  branch,
  launch_base: launchBase,
})

test('failure-kind mutation: an abandoned run is not a task-branch candidate', () => {
  const kept = addRun({ agent: 'codex', job: 'implement', status: 'stale' })
  const abandoned = addRun({ agent: 'codex', job: 'implement', status: 'stale' })
  db().query("UPDATE run SET failure_kind='abandoned' WHERE id=?").run(abandoned)
  const rows = db()
    .query(`SELECT candidate.id FROM run candidate WHERE ${taskBranchCandidacySql('candidate')}`)
    .all() as { id: number }[]
  expect(rows.map((candidate) => candidate.id)).toContain(kept)
  expect(rows.map((candidate) => candidate.id)).not.toContain(abandoned)
})

describe('task branch supersession', () => {
  test('a later explicit-base root run supersedes an earlier branch', () => {
    expect(
      isTaskBranchSuperseded('DEV-609-old', [
        row(10, 'DEV-609-old', null),
        row(11, 'DEV-609-new', 'main'),
      ]),
    ).toBe(true)
  })

  test('a later root run without a launch base does not supersede', () => {
    expect(
      isTaskBranchSuperseded('DEV-609-old', [
        row(10, 'DEV-609-old', null),
        row(11, 'DEV-609-new', null),
      ]),
    ).toBe(false)
  })

  test('a later resume with an inherited launch base does not supersede', () => {
    expect(
      isTaskBranchSuperseded('DEV-609-old', [
        row(10, 'DEV-609-old', null),
        row(11, 'DEV-609-new', 'main', 9),
      ]),
    ).toBe(false)
  })

  test('a later explicit-base run on the same branch does not supersede', () => {
    expect(
      isTaskBranchSuperseded('DEV-609-old', [
        row(10, 'DEV-609-old', null),
        row(11, 'DEV-609-old', 'main'),
      ]),
    ).toBe(false)
  })
})

const landingInput = {
  branch: 'DEV-650-orch-4390',
  tip: '6347bc9a',
  localCheck: null,
  pullRequestCheck: { state: 'unmatched' } as const,
}

describe('task branch landing decision', () => {
  test('local-check mutation: patch-equivalent content is skipped before an unknown PR result', () => {
    expect(
      decideTaskBranchLanding({
        ...landingInput,
        localCheck: 'commits',
        pullRequestCheck: { state: 'unknown', reason: 'gh failed' },
      }),
    ).toEqual({ action: 'skip' })
  })

  test('PR-name mutation: a containing merged PR head skips the branch', () => {
    expect(
      decideTaskBranchLanding({
        ...landingInput,
        pullRequestCheck: { state: 'landed', landedBy: 'name', number: 216 },
      }),
    ).toEqual({ action: 'skip', number: 216 })
  })

  test('PR-commits mutation: a patch-matching merged PR skips the branch', () => {
    expect(
      decideTaskBranchLanding({
        ...landingInput,
        pullRequestCheck: { state: 'landed', landedBy: 'pr-commits', number: 217 },
      }),
    ).toEqual({ action: 'skip', number: 217 })
  })

  test('no-match mutation: a completed unmatched PR check keeps the candidate', () => {
    expect(decideTaskBranchLanding(landingInput)).toEqual({ action: 'keep' })
  })

  test('unknown-state mutation: an incomplete PR check refuses with the explicit-base remedy', () => {
    const refusal = decideTaskBranchLanding({
      ...landingInput,
      pullRequestCheck: { state: 'unknown', reason: 'merged PR listing was truncated' },
    })
    expect(refusal).toEqual({
      action: 'refuse',
      cause: 'unknown',
      reason: 'merged PR listing was truncated',
      branch: 'DEV-650-orch-4390',
      tip: '6347bc9a',
    })
    if (refusal.action !== 'refuse') throw new Error('expected refusal')
    const message = taskBranchLandingRefusalMessage(refusal, 'develop')
    expect(message).toContain('--base DEV-650-orch-4390')
    expect(message).toContain('--base develop')
  })

  test('closed-unmerged state refuses and names the pull request and both remedies', () => {
    const refusal = decideTaskBranchLanding({
      ...landingInput,
      pullRequestCheck: { state: 'closed-unmerged', number: 413 },
    })
    expect(refusal).toEqual({
      action: 'refuse',
      cause: 'closed-unmerged',
      pullRequest: 413,
      branch: 'DEV-650-orch-4390',
      tip: '6347bc9a',
    })
    if (refusal.action !== 'refuse') throw new Error('expected refusal')
    expect(taskBranchLandingRefusalMessage(refusal, 'develop')).toBe(
      'refusing task branch DEV-650-orch-4390 tip 6347bc9a: pull request #413 was closed without merge; rerun with --base DEV-650-orch-4390 to continue from its content, or --base develop to start over',
    )
  })
})

const pullRequest = (number: number): GitHubPullRequest => ({
  number,
  state: 'MERGED',
  headRefName: `feature-${number}`,
  headRefOid: `oid-${number}`,
  title: `PR ${number}`,
  mergeCommit: null,
  mergedAt: '2026-09-18T00:00:00Z',
})

const listing = (count: number) =>
  pullRequestListing(
    Array.from({ length: count }, (_, index) => pullRequest(index)),
    GH_TARGETED_MERGED_PR_LIMIT,
  )

const taskPullRequest = (number: number, state: GitHubPullRequest['state']): GitHubPullRequest => ({
  ...pullRequest(number),
  state,
  mergedAt: state === 'MERGED' ? '2026-09-18T00:00:00Z' : null,
})

describe('targeted task branch pull-request decision', () => {
  test('truncation-guard mutation: exactly the targeted limit remains unknown', () => {
    expect(
      decideTaskBranchPullRequestCheck({
        nameListing: listing(GH_TARGETED_MERGED_PR_LIMIT),
        commitListing: listing(0),
        nameCheck: null,
        commitCheck: null,
      }),
    ).toEqual({
      state: 'unknown',
      reason: 'targeted merged pull-request listing reached 100 entries and may be truncated',
    })
  })

  test('overconservative-truncation mutation: fewer than the targeted limit is decided', () => {
    expect(
      decideTaskBranchPullRequestCheck({
        nameListing: listing(GH_TARGETED_MERGED_PR_LIMIT - 1),
        commitListing: listing(0),
        nameCheck: null,
        commitCheck: null,
      }),
    ).toEqual({ state: 'unmatched' })
  })

  test('closed-only head is withdrawn', () => {
    expect(
      decideTaskBranchPullRequestCheck({
        nameListing: { pullRequests: [taskPullRequest(413, 'CLOSED')], truncated: false },
        commitListing: listing(0),
        nameCheck: null,
        commitCheck: null,
      }),
    ).toEqual({ state: 'closed-unmerged', number: 413 })
  })

  test('an open pull request keeps a head even when another pull request was closed', () => {
    expect(
      decideTaskBranchPullRequestCheck({
        nameListing: {
          pullRequests: [taskPullRequest(413, 'CLOSED'), taskPullRequest(414, 'OPEN')],
          truncated: false,
        },
        commitListing: listing(0),
        nameCheck: null,
        commitCheck: null,
      }),
    ).toEqual({ state: 'unmatched' })
  })

  test('a merged containing pull request takes precedence over open and closed pull requests', () => {
    const merged = taskPullRequest(415, 'MERGED')
    expect(
      decideTaskBranchPullRequestCheck({
        nameListing: {
          pullRequests: [taskPullRequest(413, 'CLOSED'), taskPullRequest(414, 'OPEN'), merged],
          truncated: false,
        },
        commitListing: listing(0),
        nameCheck: { pullRequest: merged, containsTip: true },
        commitCheck: null,
      }),
    ).toEqual({ state: 'landed', landedBy: 'name', number: 415 })
  })
})

test('task branch reuse notice names branch, tip, contributing runs, and start-over base', () => {
  expect(
    taskBranchReuseNotice({
      branch: 'DEV-832-orch-5186',
      tip: 'abc123',
      commitCount: 2,
      mergeBase: 'def456',
      projectId: 1,
      projectName: 'project',
      nominatingRuns: [
        { id: 5186, sessionId: 'session-a' },
        { id: 5190, sessionId: 'session-a' },
      ],
      runIds: [5186, 5190],
      trunk: 'main',
      worktree: null,
    }),
  ).toBe(
    '! continuing task branch DEV-832-orch-5186 at tip abc123 (runs 5186, 5190); use --base main to start over',
  )
})

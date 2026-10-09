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
  selectMaximalTaskBranchCandidates,
  type TaskBranchCandidate,
  type TaskBranchRunRow,
  taskBranchAmbiguityRefusal,
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

test('an abandoned run is not a task-branch candidate', () => {
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

const branchCandidate = (
  branch: string,
  tip: string,
  commitCount: number,
  extras: Partial<TaskBranchCandidate> = {},
): TaskBranchCandidate => ({
  branch,
  tip,
  commitCount,
  mergeBase: 'merge-base',
  projectId: 1,
  projectName: 'starship',
  nominatingRuns: [{ id: commitCount, sessionId: 'session-a' }],
  trunk: 'develop',
  worktree: null,
  ...extras,
})

describe('maximal task branch candidates', () => {
  const worker = branchCandidate(
    'STAR-5307-orch-9648',
    '4e0cf76e5070417ee0ccfef1c33a7794898e2677',
    8,
    { nominatingRuns: [{ id: 9648, sessionId: 'session-a' }] },
  )
  const task = branchCandidate('STAR-5307', '684ec5d8cdc914e501d353a5c22a76b493ae33a9', 10, {
    nominatingRuns: [
      { id: 9690, sessionId: 'session-a' },
      { id: 9691, sessionId: 'session-a' },
    ],
    worktree: {
      path: '/tmp/STAR-5307',
      branch: 'STAR-5307',
      base: '684ec5d8cdc914e501d353a5c22a76b493ae33a9',
      repoRoot: '/tmp/starship',
      mintedBranch: null,
    },
  })

  test('trunk <- worker <- task-plus-one keeps the descendant task branch', () => {
    expect(
      selectMaximalTaskBranchCandidates([worker, task], 'STAR-5307', new Set([worker.tip])),
    ).toEqual([task])
  })

  test('an empty contained-tip set keeps every unique tip', () => {
    expect(selectMaximalTaskBranchCandidates([worker, task], 'STAR-5307', new Set())).toEqual([
      worker,
      task,
    ])
  })

  test('equal-tip aliases collapse to the key-named task branch', () => {
    const alias = branchCandidate(worker.branch, task.tip, 10, {
      nominatingRuns: worker.nominatingRuns,
    })
    expect(selectMaximalTaskBranchCandidates([alias, task], 'STAR-5307', new Set())).toEqual([task])
  })

  test('equal-tip aliases without a key-named branch collapse lexicographically', () => {
    const later = branchCandidate('STAR-5307-orch-9690', worker.tip, 8)
    expect(selectMaximalTaskBranchCandidates([later, worker], 'STAR-5307', new Set())).toEqual([
      worker,
    ])
  })

  test('genuinely diverged tips remain incomparable', () => {
    const other = branchCandidate(
      'STAR-5307-orch-9800',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      3,
    )
    expect(selectMaximalTaskBranchCandidates([worker, other], 'STAR-5307', new Set())).toEqual([
      worker,
      other,
    ])
  })
})

describe('task branch ambiguity refusal', () => {
  const worker = branchCandidate(
    'STAR-5307-orch-9648',
    '4e0cf76e5070417ee0ccfef1c33a7794898e2677',
    8,
    { nominatingRuns: [{ id: 9648, sessionId: 'session-a' }] },
  )
  const task = branchCandidate('STAR-5307', '684ec5d8cdc914e501d353a5c22a76b493ae33a9', 10, {
    nominatingRuns: [{ id: 9690, sessionId: 'session-a' }],
  })

  test('leads with git reconciliation before score voiding', () => {
    const message = taskBranchAmbiguityRefusal('STAR-5307', 'develop', [worker, task])
    expect(message).toContain('more than one branch carries content not on develop')
    expect(message).toContain('git branch -d STAR-5307-orch-9648')
    expect(message).toContain('git branch -d STAR-5307')
    expect(message).toContain('do not use -D')
    expect(message).toContain('false or stale')
    expect(message.indexOf('git branch -d')).toBeLessThan(message.indexOf('orch score'))
    expect(message).toContain('orch score 9648 --void')
    expect(message).toContain('orch score 9690 --void')
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
      trunk: 'main',
      worktree: null,
    }),
  ).toBe(
    '! continuing task branch DEV-832-orch-5186 at tip abc123 (runs 5186, 5190); use --base main to start over',
  )
})

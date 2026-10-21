import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { claimTreePlanForCandidate } from '../run/run-claim-plan.ts'
import {
  GH_TARGETED_MERGED_PR_LIMIT,
  type GitHubPullRequest,
  pullRequestListing,
} from './merged-pull-request.ts'
import {
  decideTaskBranchLanding,
  decideTaskBranchPullRequestCheck,
  isTaskBranchSuperseded,
  resolveTaskBranch,
  selectMaximalTaskBranchCandidates,
  type TaskBranchCandidate,
  type TaskBranchRunRow,
  taskBranchAmbiguityRefusal,
  taskBranchCandidacySql,
  taskBranchContainedTips,
  taskBranchLandingRefusalMessage,
  taskBranchLandingTreeRefusal,
  taskBranchReuseNotice,
} from './task-branch.ts'

afterEach(() => {
  mock.restore()
  rmSync(join(dir, 'landing-tree-owner-repo'), { recursive: true, force: true })
})

function spawnResult(stdout = '', exitCode = 0): ReturnType<typeof Bun.spawnSync> {
  return {
    exitCode,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(exitCode === 0 ? '' : 'failed'),
    success: exitCode === 0,
    exitedDueToTimeout: false,
  } as ReturnType<typeof Bun.spawnSync>
}

test('an evidence-excluded landing-tree owner refuses dispatch planning', () => {
  const repo = join(dir, 'landing-tree-owner-repo')
  const landingTree = join(repo, '.claude', 'worktrees', 'orch-14488')
  mkdirSync(landingTree, { recursive: true })
  const projectId = (
    db()
      .query(
        `INSERT INTO project (record_id,name,path,stack,settings)
         VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),?,?,NULL,'{"trunk":"main"}') RETURNING record_id`,
      )
      .get('landing-tree-owner-fixture', repo) as { record_id: string }
  ).record_id
  const writer = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'ok',
    session: 'session-a',
  })
  db()
    .query(
      `UPDATE run SET launch_key='DEV-1398',branch='DEV-1398-orch-14461',project_record_id=?
      WHERE record_id=?`,
    )
    .run(projectId, writer)
  const landing = addRun({ agent: 'codex', job: 'landing-tree', status: 'running' })
  db()
    .query(
      `UPDATE run SET worktree=?,project_record_id=?,
       evidence_excluded='landing tree lifecycle row; not agent execution'
      WHERE record_id=?`,
    )
    .run(landingTree, projectId, landing)
  const newerTerminalOwner = addRun({ agent: 'codex', job: 'implement', status: 'stale' })
  db()
    .query(
      `UPDATE run SET worktree=?,project_record_id=?,
       evidence_excluded='superseded fixture owner'
      WHERE record_id=?`,
    )
    .run(landingTree, projectId, newerTerminalOwner)

  const originalSpawnSync = Bun.spawnSync
  spyOn(Bun, 'spawnSync').mockImplementation(((argv: string[], options?: object) => {
    if (argv[0] === 'gh') return spawnResult('[]')
    if (argv[0] !== 'git') return originalSpawnSync(argv, options as never)
    const command = argv.join(' ')
    if (command.includes('rev-parse --local-env-vars')) {
      return spawnResult('GIT_DIR\nGIT_WORK_TREE\n')
    }
    if (command.includes('rev-parse --path-format=absolute --git-dir')) return spawnResult('', 1)
    if (command.includes('rev-parse --path-format=absolute --show-toplevel')) {
      return spawnResult(`${repo}\n`)
    }
    if (command.includes('rev-parse --path-format=absolute --git-common-dir')) {
      return spawnResult(`${join(repo, '.git')}\n`)
    }
    if (command.includes('rev-parse --verify --end-of-options main^{commit}')) {
      return spawnResult('trunk-tip\n')
    }
    if (
      command.includes(
        'rev-parse --verify --end-of-options refs/heads/DEV-1398-orch-14461^{commit}',
      )
    ) {
      return spawnResult('writer-tip\n')
    }
    if (command.includes('merge-base trunk-tip writer-tip')) return spawnResult('merge-base\n')
    if (command.includes('rev-list --count merge-base..writer-tip')) return spawnResult('1\n')
    if (command.includes('cherry trunk-tip writer-tip')) return spawnResult('+ writer-tip\n')
    if (command.includes('rev-parse --verify writer-tip^{tree}')) return spawnResult('tree-tip\n')
    if (command.includes('commit-tree tree-tip')) {
      expect(options).toMatchObject({
        env: {
          GIT_AUTHOR_NAME: 'Patch Equivalence',
          GIT_AUTHOR_EMAIL: 'patch-equivalence@orchestrator.invalid',
          GIT_COMMITTER_NAME: 'Patch Equivalence',
          GIT_COMMITTER_EMAIL: 'patch-equivalence@orchestrator.invalid',
        },
      })
      return spawnResult('squash-tip\n')
    }
    if (command.includes('cherry trunk-tip squash-tip')) return spawnResult('+ squash-tip\n')
    if (command.includes('worktree list --porcelain')) {
      return spawnResult(
        `worktree ${repo}\nbranch refs/heads/main\n\n` +
          `worktree ${landingTree}\nbranch refs/heads/DEV-1398-orch-14461\n`,
      )
    }
    throw new Error(`unexpected git fixture command: ${command}`)
  }) as typeof Bun.spawnSync)

  const candidate = resolveTaskBranch(repo, 'DEV-1398')
  expect(candidate?.worktree?.path).toBe(landingTree)
  expect(() =>
    claimTreePlanForCandidate({
      candidate,
      forbidsRepo: false,
      repoJob: true,
      hasWorktree: false,
      refusalMessage: taskBranchLandingTreeRefusal,
    }),
  ).toThrow(
    `refusing task branch DEV-1398-orch-14461: it is checked out in architect landing tree ${landingTree}.`,
  )
})

const row = (
  id: string,
  branch: string,
  launchBase: string | null,
  parentRunId: string | null = null,
): TaskBranchRunRow => ({
  record_id: String(id),
  number: Number(id),
  parent_run_record_id: parentRunId,
  branch,
  launch_base: launchBase,
})

test('an abandoned run is not a task-branch candidate', () => {
  const kept = addRun({ agent: 'codex', job: 'implement', status: 'stale' })
  const abandoned = addRun({ agent: 'codex', job: 'implement', status: 'stale' })
  db().query("UPDATE run SET failure_kind='abandoned' WHERE record_id=?").run(abandoned)
  const rows = db()
    .query(
      `SELECT candidate.record_id FROM run candidate WHERE ${taskBranchCandidacySql('candidate')}`,
    )
    .all() as { record_id: string }[]
  expect(rows.map((candidate) => candidate.record_id)).toContain(kept)
  expect(rows.map((candidate) => candidate.record_id)).not.toContain(abandoned)
})

describe('task branch supersession', () => {
  test('a later explicit-base root run supersedes an earlier branch', () => {
    expect(
      isTaskBranchSuperseded('DEV-609-old', [
        row('10', 'DEV-609-old', null),
        row('11', 'DEV-609-new', 'main'),
      ]),
    ).toBe(true)
  })

  test('a later root run without a launch base does not supersede', () => {
    expect(
      isTaskBranchSuperseded('DEV-609-old', [
        row('10', 'DEV-609-old', null),
        row('11', 'DEV-609-new', null),
      ]),
    ).toBe(false)
  })

  test('a later resume with an inherited launch base does not supersede', () => {
    expect(
      isTaskBranchSuperseded('DEV-609-old', [
        row('10', 'DEV-609-old', null),
        row('11', 'DEV-609-new', 'main', '9'),
      ]),
    ).toBe(false)
  })

  test('a later explicit-base run on the same branch does not supersede', () => {
    expect(
      isTaskBranchSuperseded('DEV-609-old', [
        row('10', 'DEV-609-old', null),
        row('11', 'DEV-609-old', 'main'),
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
  projectId: 'project-1',
  projectName: 'starship',
  nominatingRuns: [{ record_id: String(commitCount), sessionId: 'session-a' }],
  trunk: 'develop',
  worktree: null,
  worktreeOwnerJob: null,
  ...extras,
})

describe('contained task branch tips', () => {
  const worker = branchCandidate(
    'STAR-5307-orch-9648',
    '4e0cf76e5070417ee0ccfef1c33a7794898e2677',
    8,
    { nominatingRuns: [{ record_id: '9648', sessionId: 'session-a' }] },
  )
  const task = branchCandidate('STAR-5307', '684ec5d8cdc914e501d353a5c22a76b493ae33a9', 10, {
    nominatingRuns: [
      { record_id: '9690', sessionId: 'session-a' },
      { record_id: '9691', sessionId: 'session-a' },
    ],
    worktree: {
      path: '/tmp/STAR-5307',
      branch: 'STAR-5307',
      base: '684ec5d8cdc914e501d353a5c22a76b493ae33a9',
      repoRoot: '/tmp/starship',
      mintedBranch: null,
    },
  })
  const other = branchCandidate(
    'STAR-5307-orch-9800',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    3,
  )
  const workerIsAncestorOfTask = (ancestor: string, descendant: string) =>
    ancestor === worker.tip && descendant === task.tip

  test('trunk <- worker <- task-plus-one keeps the descendant task branch', () => {
    const contained = taskBranchContainedTips([worker.tip, task.tip], workerIsAncestorOfTask)
    expect(contained).toEqual(new Set([worker.tip]))
    expect(selectMaximalTaskBranchCandidates([worker, task], 'STAR-5307', contained)).toEqual([
      task,
    ])
  })

  test('genuinely diverged tips remain incomparable', () => {
    const contained = taskBranchContainedTips([worker.tip, other.tip], () => false)
    expect(contained).toEqual(new Set())
    expect(selectMaximalTaskBranchCandidates([worker, other], 'STAR-5307', contained)).toEqual([
      worker,
      other,
    ])
  })

  test('equal tips are not ancestors of one another', () => {
    expect(taskBranchContainedTips([task.tip, task.tip], () => true)).toEqual(new Set())
  })
})

describe('maximal task branch candidates', () => {
  const worker = branchCandidate(
    'STAR-5307-orch-9648',
    '4e0cf76e5070417ee0ccfef1c33a7794898e2677',
    8,
    { nominatingRuns: [{ record_id: '9648', sessionId: 'session-a' }] },
  )
  const task = branchCandidate('STAR-5307', '684ec5d8cdc914e501d353a5c22a76b493ae33a9', 10, {
    nominatingRuns: [
      { record_id: '9690', sessionId: 'session-a' },
      { record_id: '9691', sessionId: 'session-a' },
    ],
    worktree: {
      path: '/tmp/STAR-5307',
      branch: 'STAR-5307',
      base: '684ec5d8cdc914e501d353a5c22a76b493ae33a9',
      repoRoot: '/tmp/starship',
      mintedBranch: null,
    },
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
})

describe('task branch ambiguity refusal', () => {
  const worker = branchCandidate(
    'STAR-5307-orch-9648',
    '4e0cf76e5070417ee0ccfef1c33a7794898e2677',
    8,
    { nominatingRuns: [{ record_id: '9648', sessionId: 'session-a' }] },
  )
  const task = branchCandidate('STAR-5307', '684ec5d8cdc914e501d353a5c22a76b493ae33a9', 10, {
    nominatingRuns: [{ record_id: '9690', sessionId: 'session-a' }],
  })

  test('leads with git reconciliation before score voiding', () => {
    const message = taskBranchAmbiguityRefusal('STAR-5307', 'develop', [worker, task])
    expect(message).toContain('more than one branch carries content not on develop')
    expect(message).toContain('git branch -d STAR-5307-orch-9648')
    expect(message).toContain('git branch -d STAR-5307')
    expect(message).toContain('do not use -D')
    expect(message).toContain('false or stale')
    expect(message.indexOf('git branch -d')).toBeLessThan(message.indexOf(`${PLATFORM_SLUG} score`))
    expect(message).toContain(`${PLATFORM_SLUG} score 9648 --void`)
    expect(message).toContain(`${PLATFORM_SLUG} score 9690 --void`)
  })
})

test('task branch reuse notice names branch, tip, contributing runs, and start-over base', () => {
  expect(
    taskBranchReuseNotice({
      branch: 'DEV-832-orch-5186',
      tip: 'abc123',
      commitCount: 2,
      mergeBase: 'def456',
      projectId: 'project-1',
      projectName: 'project',
      nominatingRuns: [
        { record_id: '5186', sessionId: 'session-a' },
        { record_id: '5190', sessionId: 'session-a' },
      ],
      trunk: 'main',
      worktree: null,
      worktreeOwnerJob: null,
    }),
  ).toBe(
    '! continuing task branch DEV-832-orch-5186 at tip abc123 (runs 5186, 5190); use --base main to start over',
  )
})

import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '../database/db.ts'
import { projectByName } from '../project/projects.ts'
import { measureChangeIdentity } from '../review/review-pins.ts'
import {
  admissionDecision,
  type PullRequestChange,
  recordTriageOverrideForChange,
} from './pr-admission.ts'
import {
  mergePullRequest,
  type PullRequestMergeAdapter,
  type PullRequestMergeFacts,
} from './pr-merge.ts'

const headBranch = 'DEV-2074-override'

const pullRequest = (headCommit: string): PullRequestMergeFacts => ({
  nodeId: 'PR_node_id',
  number: 42,
  url: 'https://github.example/pulls/42',
  headCommit,
  headBranch,
  baseBranch: 'main',
  title: 'Honor the recorded triage override',
  state: 'OPEN',
  mergeStateStatus: 'CLEAN',
  mergeCommit: null,
})

function git(repo: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function registerProject(path: string): void {
  db()
    .query(
      'INSERT INTO project (record_id,name,path,stack,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),?,?,?,?)',
    )
    .run(
      'merge-override-fixture',
      path,
      'bun',
      JSON.stringify({
        trunk: 'main',
        release: {
          rungs: [],
          mergeMethod: 'squash',
          requiredChecks: ['test'],
          mergeQueue: false,
        },
      }),
    )
}

function changeAt(repo: string, base: string, tip: string): PullRequestChange {
  const project = projectByName('merge-override-fixture')!
  const identity = measureChangeIdentity(repo, base, tip)
  if (!identity) throw new Error(`could not measure ${base}..${tip}`)
  return {
    project,
    branch: headBranch,
    tip,
    tree: git(repo, 'rev-parse', `${tip}^{tree}`),
    base,
    group: {
      project: project.name,
      branch: headBranch,
      patchId: identity.patchId,
      pathSet: identity.paths,
    },
    tier: 2,
    applicability: { lenses: ['correctness'] },
  }
}

function adapterFor(
  repo: string,
  base: string,
  headCommit: string,
  mergedHeads: string[],
  database: Database,
): PullRequestMergeAdapter {
  return {
    repository: () => 'example/repository',
    view: () => pullRequest(headCommit),
    checks: () => [
      {
        name: 'test',
        bucket: 'pass',
        state: 'SUCCESS',
        link: 'https://checks.example/test',
      },
    ],
    landingState: () => ({ remoteLandingTip: 'base', mergeBase: 'base' }),
    hasCommit: () => true,
    admission: (_cwd, admittedHead) => {
      const change = changeAt(repo, base, admittedHead)
      return { change, decision: admissionDecision(change, database) }
    },
    recordAdmission: () => null,
    postMergeChange: () => changeAt(repo, base, headCommit),
    merge: (_cwd, _number, _method, _subject, admittedHead) => {
      mergedHeads.push(admittedHead)
      throw new Error('stop after admission')
    },
    mergeCommit: () => 'unreachable',
    queueState: () => ({
      pullRequestState: 'OPEN',
      mergeCommit: null,
      entryState: null,
      enqueuedAt: null,
    }),
    enqueue: () => {},
    requeue: () => {},
    failedMergeGroupRun: () => null,
    now: Date.now,
    wait: () => {},
  }
}

test("merge honors create's triage override for the same patch after a rebase", () => {
  const repo = mkdtempSync(join(tmpdir(), 'pr-merge-override-'))
  try {
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 'fixture@example.test')
    git(repo, 'config', 'user.name', 'Fixture')
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    git(repo, 'add', 'base.txt')
    git(repo, 'commit', '-qm', 'base')
    const recordedBase = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'checkout', '-qb', headBranch)
    writeFileSync(join(repo, 'feature.txt'), 'reviewed change\n')
    git(repo, 'add', 'feature.txt')
    git(repo, 'commit', '-qm', 'feature')
    const recordedHead = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'checkout', '-q', 'main')
    writeFileSync(join(repo, 'unrelated.txt'), 'new base\n')
    git(repo, 'add', 'unrelated.txt')
    git(repo, 'commit', '-qm', 'new base')
    const changedBase = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'cherry-pick', recordedHead)
    const changedHead = git(repo, 'rev-parse', 'HEAD')

    registerProject(repo)
    const database = db()
    recordTriageOverrideForChange(
      changeAt(repo, recordedBase, recordedHead),
      { overrideReason: 'operator accepts the reviewed risk', fromOperator: true },
      database,
    )
    const mergedHeads: string[] = []

    expect(() =>
      mergePullRequest(
        '42',
        repo,
        adapterFor(repo, changedBase, changedHead, mergedHeads, database),
        database,
      ),
    ).toThrow('review triage is incomplete')
    expect(mergedHeads).toEqual([])

    expect(() =>
      mergePullRequest(
        '42',
        repo,
        adapterFor(repo, recordedBase, recordedHead, mergedHeads, database),
        database,
      ),
    ).toThrow('stop after admission')
    expect(mergedHeads).toEqual([recordedHead])
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { db } from '../database/db.ts'
import { projectByName } from '../project/projects.ts'
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
import type { TriageDecision } from './triage-decision.ts'

const cwd = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')
const recordedHead = 'recorded-head'
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
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  mergeCommit: null,
})

const incompleteTriage: TriageDecision = {
  complete: false,
  snapshot: {
    reviewRecordIds: [],
    patchId: 'patch',
    tier: 2,
    lensRounds: 0,
    findingCount: 0,
    admissionPath: 'exact_review',
    readRecordId: null,
  },
  missingReview: true,
  unfinishedReviewNumbers: [],
  undisposedFindings: [],
  missingLenses: [{ lens: 'correctness', recordedOnBranch: false, newlyTouchedPaths: [] }],
  lensesAlreadyComplete: [],
  missingSecondOpinion: null,
  architectReadRequired: false,
  earlierReviewNumber: null,
  earlierReviewTier: null,
  finalTierRaised: false,
  noCompleteReviewRound: true,
}

function registerProject(): void {
  db()
    .query(
      'INSERT INTO project (record_id,name,path,stack,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),?,?,?,?)',
    )
    .run(
      'merge-override-fixture',
      cwd,
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

function changeAt(tip: string): PullRequestChange {
  const project = projectByName('merge-override-fixture')!
  return {
    project,
    branch: headBranch,
    tip,
    tree: 'head-tree',
    group: {
      project: project.name,
      branch: headBranch,
      patchId: 'patch',
      pathSet: ['orchestrator/src/pull-request/pr-merge.ts'],
    },
    tier: 2,
    applicability: { lenses: ['correctness'] },
  }
}

function adapterFor(
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
      const change = changeAt(admittedHead)
      return {
        change,
        decision: admissionDecision(change, database, incompleteTriage),
      }
    },
    recordAdmission: () => null,
    postMergeChange: () => changeAt(headCommit),
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

test("merge honors create's triage override only for its recorded head", () => {
  registerProject()
  const database = db()
  recordTriageOverrideForChange(
    changeAt(recordedHead),
    { overrideReason: 'operator accepts the reviewed risk', fromOperator: true },
    database,
  )
  const mergedHeads: string[] = []

  expect(() =>
    mergePullRequest('42', cwd, adapterFor('changed-head', mergedHeads, database), database),
  ).toThrow('review triage is incomplete')
  expect(mergedHeads).toEqual([])

  expect(() =>
    mergePullRequest('42', cwd, adapterFor(recordedHead, mergedHeads, database), database),
  ).toThrow('stop after admission')
  expect(mergedHeads).toEqual([recordedHead])
})

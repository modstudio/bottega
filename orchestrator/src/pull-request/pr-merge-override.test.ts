import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { projectByName } from '../project/projects.ts'
import type { ReviewFunnelVerdict } from '../review-funnel/decide-review-funnel.ts'
import {
  landingOverrideMatches,
  overrideFacts,
  readLandingOverridesForBranch,
} from '../review-funnel/gather-funnel-facts.ts'
import type { TriageDecision } from '../review-funnel/review-funnel-admission-evidence.ts'
import { decideAdmission } from './admission-decision.ts'
import { type PullRequestChange, recordTriageOverrideForChange } from './pr-admission.ts'
import {
  mergePullRequest,
  type PullRequestMergeAdapter,
  type PullRequestMergeFacts,
} from './pr-merge.ts'

const cwd = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')
const recordedHead = 'recorded-head'
const rebasedHead = 'rebased-head'
const changedHead = 'changed-head'
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
    base: 'base',
    tree: 'head-tree',
    group: {
      project: project.name,
      branch: headBranch,
      patchId: tip === recordedHead ? 'pre-rebase' : 'post-rebase',
      zeroContextPatchId: tip === changedHead ? 'zero-different' : 'zero-shared',
      pathSet: ['orchestrator/src/pull-request/pr-merge.ts'],
    },
    tier: 2,
    applicability: { lenses: ['correctness'] },
  }
}

function funnelVerdict(head: string): ReviewFunnelVerdict {
  return {
    policyVersion: 'builtin',
    mode: 'evaluate',
    change: {
      project: 'merge-override-fixture',
      taskKey: 'DEV-2074',
      branch: headBranch,
      head,
      patchId: head === recordedHead ? 'pre-rebase' : 'post-rebase',
      zeroContextPatchId: head === changedHead ? 'zero-different' : 'zero-shared',
      pathSet: '["orchestrator/src/pull-request/pr-merge.ts"]',
      paths: ['orchestrator/src/pull-request/pr-merge.ts'],
    },
    tier: { tier: 2, risk: 2, size: 1, firm: false, lowered: false, reasons: [] },
    budget: { roundsUsed: 0, ceiling: 2, atCeiling: false },
    selection: { mode: 'evaluate', lenses: [] },
    lenses: [{ lens: 'correctness', status: 'owed', reason: 'initial' }],
    next: { action: 'dispatch', lenses: ['correctness'] },
    remedy: `${PLATFORM_SLUG} review lens correctness ${headBranch}`,
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
      const verdict = funnelVerdict(admittedHead)
      const overrides = readLandingOverridesForBranch(database, change.project.name, change.branch)
      return {
        change,
        decision: {
          kind: 'measured',
          ...decideAdmission(verdict, overrides),
          verdict,
          triage: incompleteTriage,
        },
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

test("merge honors create's triage override for the same patch after a rebase", () => {
  registerProject()
  const database = db()
  recordTriageOverrideForChange(
    changeAt(recordedHead),
    { overrideReason: 'Shmuel Barkin accepts the reviewed risk', fromOperator: true },
    database,
  )
  const ceilingOverrideId = newRecordId()
  database
    .query(
      `INSERT INTO landing_override
        (record_id,project,project_record_id,branch,tip,tree,patch_id,zero_context_patch_id,path_set,reason,attribution,missing_lenses,session_id,at)
       SELECT ?,project,project_record_id,branch,tip,tree,patch_id,zero_context_patch_id,path_set,reason,
              'architect-ceiling','["correctness"]',session_id,strftime('%Y-%m-%dT%H:%M:%fZ',at,'+1 second')
         FROM landing_override WHERE project='merge-override-fixture' AND branch=?`,
    )
    .run(ceilingOverrideId, headBranch)
  expect(
    overrideFacts(database, {
      project: 'merge-override-fixture',
      branch: headBranch,
      patchId: 'post-rebase',
      zeroContextPatchId: 'zero-shared',
      pathSet: '["orchestrator/src/pull-request/pr-merge.ts"]',
    }),
  ).toEqual({ ceilingRuling: true, overriddenLenses: ['correctness'] })
  expect(
    overrideFacts(database, {
      project: 'merge-override-fixture',
      branch: headBranch,
      patchId: 'post-rebase',
      zeroContextPatchId: 'zero-different',
      pathSet: '["orchestrator/src/pull-request/pr-merge.ts"]',
    }),
  ).toEqual({ ceilingRuling: false, overriddenLenses: [] })
  database.query('DELETE FROM landing_override WHERE record_id=?').run(ceilingOverrideId)
  const mergedHeads: string[] = []

  expect(() =>
    mergePullRequest('42', cwd, adapterFor(rebasedHead, mergedHeads, database), database),
  ).toThrow('stop after admission')
  expect(mergedHeads).toEqual([rebasedHead])

  expect(() =>
    mergePullRequest('42', cwd, adapterFor(recordedHead, mergedHeads, database), database),
  ).toThrow('stop after admission')
  expect(mergedHeads).toEqual([rebasedHead, recordedHead])

  expect(() =>
    mergePullRequest('42', cwd, adapterFor(changedHead, mergedHeads, database), database),
  ).toThrow('review triage is incomplete')
  expect(mergedHeads).toEqual([rebasedHead, recordedHead])
})

test('the landing override matcher requires a matching replay witness for another identity', () => {
  const candidate = {
    recordId: 'override',
    project: 'fixture',
    branch: 'DEV-2364-work',
    tip: 'old-tip',
    tree: 'old-tree',
    patchId: 'old-patch',
    zeroContextPatchId: 'old-zero',
    pathSet: '["a.ts"]',
    attribution: 'operator' as const,
    reason: 'accepted',
    missingLenses: [],
  }
  const current = {
    patchId: 'new-patch',
    zeroContextPatchId: 'new-zero',
    pathSet: '["a.ts"]',
  }
  expect(landingOverrideMatches({ ...candidate, replayMatchesCurrent: true }, current)).toBe(true)
  expect(landingOverrideMatches({ ...candidate, replayMatchesCurrent: false }, current)).toBe(false)
})

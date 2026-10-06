// concern: run-retry-workspace
/** Resolves and validates the retained or reprovisioned tree used by a fresh retry. */

import { existsSync } from 'node:fs'
import { pidAlive } from '../../../shared/process-identity.ts'
import { db } from '../database/db.ts'
import { branchOf, gitContext, gitOk } from '../git/git-environment.ts'
import { projectByName, resolvedWorktreeTool } from '../project/projects.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import { assertBranchHasNoAliveOwner } from './branch-owner-guard.ts'
import { latestCheckpoint } from './checkpoint.ts'
import {
  continuationReadOnlyBase,
  continuationTreeCwd,
  requireContinuationTree,
} from './continuation-tree-service.ts'
import { type ResumeTreePlan, resumeTreePlan } from './resume-tree.ts'
import { runAlive } from './run-alive.ts'
import { refuseHeldContinuationBranch } from './run-control.ts'
import { runLeaseState } from './run-lease.ts'
import type { RunResumeOptions } from './run-resume-options.ts'
import { decideWritingRetryWorkspace, type RetryBranchTipRelation } from './run-retry.ts'

export type WritingRetryWorkspace = {
  cwd: string
  commit: string
  worktree: Worktree | null
  treePlan?: Extract<ResumeTreePlan, { action: 'recreate-on-branch' | 'recreate-then-restore' }>
}

export function resolveRetryTree(input: {
  rootId: number
  projectName: string | null
  projectPath: string | null
  readsRepo: boolean
  writesRepo: boolean
  checkoutCwd: string
  recordedWorktree: string | null
  baseCommit: string | null
  agent: string
  sessionId: string | null
}): { cwd: string; resume: RunResumeOptions | undefined } {
  if (input.writesRepo) return { cwd: input.checkoutCwd, resume: undefined }
  const decision = requireContinuationTree({
    rootId: input.rootId,
    projectName: input.projectName,
    projectPath: input.projectPath,
    readsRepo: input.readsRepo,
    writesRepo: false,
    recordedTreeMatches: false,
    recordedWorktree: input.recordedWorktree,
    writerTreeRecoverable: false,
    baseCommit: input.baseCommit,
  })
  const resume =
    decision.action === 'provision-reader-tree'
      ? {
          kind: 'retry-root' as const,
          parent: input.rootId,
          agent: input.agent,
          turn: 1,
          sessionId: input.sessionId,
          worktree: null,
          readOnlyBase: continuationReadOnlyBase(decision),
        }
      : undefined
  return {
    cwd: continuationTreeCwd(decision, input.checkoutCwd, input.projectPath),
    resume,
  }
}

function branchTipRelation(
  projectPath: string,
  recordedTip: string,
  liveTip: string | null,
): RetryBranchTipRelation {
  if (!liveTip) return 'missing'
  if (liveTip === recordedTip) return 'recorded'
  return gitOk(['merge-base', '--is-ancestor', recordedTip, liveTip], projectPath) !== null
    ? 'descendant'
    : 'diverged'
}

export function resolveWritingRetryWorkspace(input: {
  id: number
  rootId: number
  job: string
  launchKey: string | null
  repo: string | null
  projectId: number | null
  branchKept: string | null
  branchKeptTip: string | null
  strandedRecordOnly: boolean
}): WritingRetryWorkspace {
  const latest = db()
    .query(
      `SELECT id,cwd,worktree,branch,base_commit,worktree_source,branch_kept_tip,status,pid
       FROM run WHERE id=? OR parent_run_id=? ORDER BY turn DESC,id DESC LIMIT 1`,
    )
    .get(input.rootId, input.rootId) as {
    id: number
    cwd: string | null
    worktree: string | null
    branch: string | null
    base_commit: string | null
    worktree_source: Worktree['source'] | null
    branch_kept_tip: string | null
    status: string
    pid: number | null
  }
  const project = input.repo ? projectByName(input.repo) : null
  if (!project) {
    throw new Error(
      `run ${input.id} cannot retry on its branch: no registered project contains its recorded checkout`,
    )
  }
  const branch = latest.branch ?? input.branchKept
  const checkpoint = latestCheckpoint(db(), input.rootId)
  const recordedTip =
    latest.branch_kept_tip ?? input.branchKeptTip ?? checkpoint?.commit_sha ?? latest.base_commit
  const startOver = `orch do ${input.job} --key ${input.launchKey ?? '<key>'} ...`
  if (!branch || !recordedTip) {
    throw new Error(
      `run ${input.id} has no recorded run branch or tip; start over with ${startOver}`,
    )
  }
  const liveTip = gitContext(project.path, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`)
  const relation = branchTipRelation(project.path, recordedTip, liveTip)
  const recordedTreeMatches = Boolean(
    latest.worktree && existsSync(latest.worktree) && branchOf(latest.worktree) === branch,
  )
  const decision = decideWritingRetryWorkspace({
    treeExists: recordedTreeMatches,
    treeLive:
      !input.strandedRecordOnly &&
      runAlive({
        status: latest.status,
        lease: runLeaseState(latest.id),
        pidAlive: Boolean(latest.pid && pidAlive(latest.pid)),
      }),
    branchTipRelation: relation,
  })
  if (decision.action === 'refuse-branch') {
    if (decision.relation === 'missing') {
      throw new Error(
        `run ${input.id} branch ${branch} is gone; recorded tip ${recordedTip}; ` +
          `start over with ${startOver}`,
      )
    }
    throw new Error(
      `run ${input.id} branch ${branch} tip ${liveTip} does not descend from recorded tip ${recordedTip}; ` +
        `start over with ${startOver}`,
    )
  }
  if (decision.action === 'refuse-live-owner') {
    throw new Error(
      `run ${latest.id} still has a live owner on worktree ${latest.worktree}; ` +
        `wait for or stop it, then retry orch retry ${input.id}`,
    )
  }
  assertBranchHasNoAliveOwner({
    branch,
    conversationRootId: input.rootId,
    projectId: input.projectId,
    projectName: input.repo,
    retryCommand: `orch retry ${input.id}`,
  })
  if (!liveTip) throw new Error(`run ${input.id} branch ${branch} has no live tip`)
  if (decision.action === 'reuse-tree') {
    return {
      cwd: latest.worktree!,
      commit: liveTip,
      worktree: {
        path: latest.worktree!,
        branch,
        base: liveTip,
        repoRoot: project.path,
        source: latest.worktree_source ?? undefined,
      },
    }
  }
  const worktreeTool = resolvedWorktreeTool(project)
  const plan = resumeTreePlan({
    rootId: input.rootId,
    branch,
    recordedTreeMatches: false,
    hasCreate: Boolean(worktreeTool?.create || worktreeTool?.recipe || worktreeTool?.recipePath),
    branchTip: liveTip,
    retainedTip: null,
    recordedTip,
  })
  if (plan.action === 'attach-recorded' || plan.action === 'refuse') {
    throw new Error(`run ${input.id} could not prepare branch ${branch} for retry`)
  }
  refuseHeldContinuationBranch(input.id, project.path, latest.worktree, plan)
  if (worktreeTool?.create && !worktreeTool.recipe && !worktreeTool.recipePath) {
    throw new Error(
      `run ${input.id} cannot reopen branch ${branch}: its command-template lifecycle cannot open an existing branch; ` +
        `start over with ${startOver}`,
    )
  }
  return { cwd: project.path, commit: liveTip, worktree: null, treePlan: plan }
}

// concern: landing-tree
/** Opens an architect-owned, project-provisioned tree on a finished run branch. */

import { createHash } from 'node:crypto'
import { closeOutRun } from '../close/close-out.ts'
import { db, nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { branchOf, checkedOutWorktree, gitContext } from '../git/git-environment.ts'
import { withWorktreeCreateLock } from '../project/project-lock.ts'
import { projectAt, resolvedWorktreeTool, stackAt } from '../project/projects.ts'
import {
  claimRecipePort,
  RECIPE_PORT_BAND,
  recordCreatedWorktreeClaims,
  recordDatabaseClaim,
} from '../resources/resource-claims.ts'
import { assertBranchHasNoAliveOwner } from '../run/branch-owner-guard.ts'
import { continuationBranchPlan, resumeTreePlan } from '../run/resume-tree.ts'
import { prepareResumeBranchIfNeeded } from '../run/run-resume-claim.ts'
import { createWorkerWorktree } from '../worktree/worktree.ts'
import { inspectTreeOwnership } from '../worktree/worktree-attribution.ts'
import type { RecordRecipeResource } from '../worktree/worktree-create.ts'
import { resolveWorktreeLifecycle } from '../worktree/worktree-lifecycle.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import {
  LANDING_TREE_AGENT,
  LANDING_TREE_EVIDENCE_EXCLUSION,
  LANDING_TREE_JOB,
  landingTreeCommandBase,
  landingTreeCommandCapability,
  landingTreeOpeningRefusal,
} from './landing-tree.ts'

type RunRow = {
  id: number
  parent_run_id: number | null
  repo: string | null
  project_id: number | null
  cwd: string | null
  worktree: string | null
  branch: string | null
  branch_kept: string | null
  branch_kept_tip: string | null
  launch_cwd: string | null
  launch_key: string | null
  launch_seed: string | null
}

function sourceRun(runId: number): { root: RunRow; latest: RunRow } {
  const selected = db().query('SELECT * FROM run WHERE id=?').get(runId) as RunRow | null
  if (!selected) throw new Error(`no run ${runId}; pass an existing writer run id`)
  const rootId = selected.parent_run_id ?? selected.id
  const root = db().query('SELECT * FROM run WHERE id=?').get(rootId) as RunRow
  const latest = db()
    .query('SELECT * FROM run WHERE id=? OR parent_run_id=? ORDER BY turn DESC,id DESC LIMIT 1')
    .get(rootId, rootId) as RunRow
  return { root, latest }
}

export type OpenedLandingTree = { path: string; branch: string; tip: string }

/** Settle a failed landing-tree row even when its project remover already removed the directory. */
export function releaseFailedLandingTree(runId: number): void {
  const recorded = db().query('SELECT worktree FROM run WHERE id=?').get(runId) as {
    worktree: string | null
  }
  if (!recorded.worktree) return
  const cleanup = closeOutRun(runId, { intent: 'tree-remove' })
  if (!['released', 'absent'].includes(cleanup.outcome)) {
    throw new Error(`landing tree cleanup ${cleanup.outcome}: ${cleanup.detail}`)
  }
}

function resolveLandingTarget(runId: number, root: RunRow, latest: RunRow) {
  const project = projectAt(latest.cwd ?? root.launch_cwd ?? '')
  if (!project) {
    throw new Error(
      `run ${runId} has no registered project checkout; repair its project registration before opening the tree`,
    )
  }
  const latestBranchTip = latest.branch
    ? gitContext(project.path, 'rev-parse', '--verify', `refs/heads/${latest.branch}^{commit}`)
    : null
  const branchPlan = continuationBranchPlan({
    latestBranch: latest.branch,
    latestBranchTip,
    rootBranch: root.branch_kept,
  })
  const branch = branchPlan.branch
  const missingBranch = landingTreeOpeningRefusal({ branch, seeds: [] })
  if (missingBranch) throw new Error(`run ${runId}: ${missingBranch}`)
  if (!branch) throw new Error(`run ${runId}: conversation branch resolution failed`)
  const liveTip = gitContext(project.path, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`)
  const plan = resumeTreePlan({
    rootId: root.id,
    branch,
    recordedTreeMatches: false,
    hasCreate: false,
    branchTip: liveTip,
    retainedTip: gitContext(
      project.path,
      'rev-parse',
      '--verify',
      `refs/orch/retained/${root.id}^{commit}`,
    ),
    recordedTip: root.branch_kept_tip,
  })
  if (plan.action === 'refuse' || plan.action === 'attach-recorded') {
    throw new Error(
      `run ${runId} branch ${branch} has no recoverable tip; restore refs/heads/${branch} or refs/orch/retained/${root.id}, then retry`,
    )
  }
  return { project, branch, plan }
}

export function openLandingTree(runId: number, seed?: string): OpenedLandingTree {
  const { root, latest } = sourceRun(runId)
  const { project, branch, plan } = resolveLandingTarget(runId, root, latest)
  const tool = resolvedWorktreeTool(project)
  const lifecycle = resolveWorktreeLifecycle(tool)
  const seedRefusal = landingTreeOpeningRefusal({
    branch,
    seeds: tool?.seeds ?? [],
    seed,
  })
  if (seedRefusal) throw new Error(`project ${project.name}: ${seedRefusal}`)
  let templateBase: string | undefined
  if (lifecycle.form === 'command-templates') {
    const capability = landingTreeCommandCapability(tool!.create!)
    if (!capability.allowed) throw new Error(`${project.name}: ${capability.reason}`)
    templateBase = landingTreeCommandBase(project.settings.trunk)
  }
  assertBranchHasNoAliveOwner({
    branch,
    conversationRootId: null,
    projectId: project.id,
    projectName: project.name,
    retryCommand: `orch tree open ${runId}${seed ? ` --seed ${seed}` : ''}`,
  })
  const existingPath = checkedOutWorktree(project.path, branch)
  if (existingPath) {
    throw new Error(
      `branch ${branch} already has a live tree at ${existingPath}; use that path or release it with orch tree remove ${existingPath}`,
    )
  }
  writableDb()
  const startedAt = nowIso()
  const prompt = `landing tree for run ${runId}`
  const inserted = db()
    .query(
      `INSERT INTO run
       (started_at,agent,job,repo,project_id,cwd,prompt_sha,prompt_bytes,prompt_head,status,
        session_id,launch_cwd,launch_key,launch_base,launch_seed,stack,evidence_excluded,pid)
       VALUES (?,?,?,?,?,?,?,?,?,'running',?,?,?,?,?,?,?,?) RETURNING id`,
    )
    .get(
      startedAt,
      LANDING_TREE_AGENT,
      LANDING_TREE_JOB,
      project.name,
      project.id,
      project.path,
      createHash('sha256').update(prompt).digest('hex').slice(0, 16),
      Buffer.byteLength(prompt),
      prompt,
      sessionId(),
      project.path,
      root.launch_key,
      templateBase ?? plan.tip,
      seed ?? null,
      stackAt(project.path),
      LANDING_TREE_EVIDENCE_EXCLUSION,
      process.pid,
    ) as { id: number }

  const record = (created: Worktree) =>
    writeTransaction(() => {
      db()
        .query(
          `UPDATE run SET cwd=?,worktree=?,branch=?,minted_branch=NULL,base_commit=?,worktree_source=?,
                  resource_teardown=CASE WHEN ?='recipe' THEN 'pending' ELSE resource_teardown END
           WHERE id=?`,
        )
        .run(
          created.path,
          created.path,
          branch,
          plan.tip,
          created.source ?? null,
          created.source ?? null,
          inserted.id,
        )
      recordCreatedWorktreeClaims(db(), {
        rootRunId: inserted.id,
        runId: inserted.id,
        projectId: project.id,
        owned: true,
        path: created.path,
        head: plan.tip,
        mintedBranch: null,
        label: String(inserted.id),
        claimedAt: nowIso(),
      })
    })
  const recordRecipeResource: RecordRecipeResource = (resource) =>
    writeTransaction(() =>
      recordDatabaseClaim(db(), {
        rootRunId: inserted.id,
        runId: inserted.id,
        projectId: project.id,
        claimedAt: nowIso(),
        provider: resource.provider,
        name: resource.name,
      }),
    )
  const claimRecipeServePort = () =>
    writeTransaction(() =>
      claimRecipePort(db(), {
        rootRunId: inserted.id,
        runId: inserted.id,
        projectId: project.id,
        claimedAt: nowIso(),
        band: RECIPE_PORT_BAND,
      }),
    )
  try {
    const created = withWorktreeCreateLock(project.path, () => {
      assertBranchHasNoAliveOwner({
        branch,
        conversationRootId: null,
        projectId: project.id,
        projectName: project.name,
        retryCommand: `orch tree open ${runId}${seed ? ` --seed ${seed}` : ''}`,
      })
      prepareResumeBranchIfNeeded(project.path, plan)
      return createWorkerWorktree({
        tool,
        cwd: project.path,
        mainProjectPath: project.path,
        runId: inserted.id,
        writes: true,
        readOnlyBase: plan.tip,
        seed,
        key: root.launch_key ?? undefined,
        baseRef: plan.tip,
        record,
        detached: false,
        existingBranch: branch,
        existingBranchTip: plan.tip,
        recordRecipeResource,
        claimRecipePort: claimRecipeServePort,
        templateBaseRef: templateBase,
        mainStackConsumers: project.settings.mainStack?.consumers,
        mainStackRequiredServices: project.settings.mainStack?.requiredServices,
        mainStackProject: { id: project.id, name: project.name },
      })
    })
    const actualBranch = branchOf(created.path)
    const actualTip = gitContext(created.path, 'rev-parse', '--verify', 'HEAD^{commit}')
    const recorded = db()
      .query('SELECT worktree,branch,base_commit,minted_branch FROM run WHERE id=?')
      .get(inserted.id) as {
      worktree: string | null
      branch: string | null
      base_commit: string | null
      minted_branch: string | null
    }
    if (
      actualBranch !== branch ||
      actualTip !== plan.tip ||
      recorded.worktree !== created.path ||
      recorded.branch !== branch ||
      recorded.base_commit !== plan.tip ||
      recorded.minted_branch !== null ||
      inspectTreeOwnership(created.path, project.path, [inserted.id], tool?.branch) !== 'owned'
    ) {
      throw new Error(
        `landing tree postcondition failed: expected ${branch} at ${plan.tip} with run ${inserted.id} ownership`,
      )
    }
    db()
      .query("UPDATE run SET status='ok',latency_ms=?,exit_code=0 WHERE id=?")
      .run(Math.max(0, Date.now() - Date.parse(startedAt)), inserted.id)
    return { path: created.path, branch, tip: plan.tip }
  } catch (error) {
    db()
      .query("UPDATE run SET status='failed',latency_ms=?,exit_code=1,error=? WHERE id=?")
      .run(
        Math.max(0, Date.now() - Date.parse(startedAt)),
        String((error as Error)?.message ?? error),
        inserted.id,
      )
    try {
      releaseFailedLandingTree(inserted.id)
    } catch (cleanupError) {
      throw new Error(
        `${String((error as Error)?.message ?? error)}; ${String((cleanupError as Error)?.message ?? cleanupError)}`,
      )
    }
    throw error
  }
}

// concern: landing-tree
/** Opens an architect-owned, project-provisioned tree on a finished run branch. */

import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
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
import { worktreePathSpellings } from '../resources/resource-ownership.ts'
import { assertBranchHasNoAliveOwner } from '../run/branch-owner-guard.ts'
import { continuationBranchPlan, resumeTreePlan } from '../run/resume-tree.ts'
import { nextRunNumber } from '../run/run-number.ts'
import { prepareResumeBranchIfNeeded } from '../run/run-resume-claim.ts'
import { TERMINAL_RUN_STATUS_SET } from '../run/run-status.ts'
import { createWorkerWorktree } from '../worktree/worktree.ts'
import { inspectTreeOwnership } from '../worktree/worktree-attribution.ts'
import type { RecordRecipeResource } from '../worktree/worktree-create.ts'
import { resolveWorktreeLifecycle } from '../worktree/worktree-lifecycle.ts'
import { projectSeedPreflight, validateProjectSeed } from '../worktree/worktree-seed.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import type { LandingTreeRunRow } from './landing-tree.ts'
import {
  LANDING_TREE_AGENT,
  LANDING_TREE_EVIDENCE_EXCLUSION,
  LANDING_TREE_JOB,
  landingTreeCommandBase,
  landingTreeCommandCapability,
  landingTreeExistingCheckoutRefusal,
  landingTreeOpeningRefusal,
} from './landing-tree.ts'
import { adoptCoordinatorRunsForLanding } from './run-adoption.ts'

export function landingTreeSeedRequest(input: {
  requested: string | undefined
  recordedLaunchSeed: string | null
  project: Parameters<typeof projectSeedPreflight>[0]['project']
  tool: Parameters<typeof projectSeedPreflight>[0]['tool']
  baseRef: string | undefined
}): Parameters<typeof projectSeedPreflight>[0] {
  return {
    requested: input.requested,
    inherited: input.recordedLaunchSeed ?? undefined,
    writesRepo: true,
    project: input.project,
    tool: input.tool,
    baseRef: input.baseRef,
  }
}

export function landingTreeSourceRun(runId: string): {
  root: LandingTreeRunRow
  latest: LandingTreeRunRow
} {
  const columns = `record_id,parent_run_record_id,repo,project_record_id,cwd,worktree,branch,
    branch_kept,branch_kept_tip,launch_cwd,launch_key,launch_seed,session_id,job,label`
  const selected = db()
    .query(`SELECT ${columns} FROM run WHERE record_id=?`)
    .get(runId) as LandingTreeRunRow | null
  if (!selected) throw new Error(`no run ${runId}; pass an existing writer run id`)
  const rootId = selected.parent_run_record_id ?? selected.record_id
  const root = db()
    .query(`SELECT ${columns} FROM run WHERE record_id=?`)
    .get(rootId) as LandingTreeRunRow
  const latest = db()
    .query(
      `SELECT ${columns} FROM run WHERE record_id=? OR parent_run_record_id=? ORDER BY turn DESC,number DESC LIMIT 1`,
    )
    .get(rootId, rootId) as LandingTreeRunRow
  return { root, latest }
}

export type OpenedLandingTree = { path: string; branch: string; tip: string }

function terminalRunAt(path: string): { recordId: string; job: string } | null {
  const spellings = worktreePathSpellings(db(), path)
  if (spellings.length === 0) return null
  const rows = db()
    .query(
      `SELECT owner.record_id recordId,owner.job,owner.status status FROM run owner
       JOIN run root ON root.record_id=COALESCE(owner.parent_run_record_id,owner.record_id)
       WHERE owner.worktree IN (${spellings.map(() => '?').join(',')}) ORDER BY owner.number DESC`,
    )
    .all(...spellings) as { recordId: string; job: string; status: string }[]
  return rows.find(({ status }) => TERMINAL_RUN_STATUS_SET.has(status)) ?? null
}

function refuseExistingLandingTree(
  projectPath: string,
  branch: string,
  retryCommand: string,
): void {
  const path = checkedOutWorktree(projectPath, branch)
  if (!path) return
  throw new Error(
    landingTreeExistingCheckoutRefusal({
      branch,
      path,
      terminalRun: terminalRunAt(path),
      retryCommand,
    }),
  )
}

/** Settle a failed landing-tree row even when its project remover already removed the directory. */
export function releaseFailedLandingTree(runId: string): void {
  const recorded = db().query('SELECT worktree FROM run WHERE record_id=?').get(runId) as {
    worktree: string | null
  }
  if (!recorded.worktree) return
  const cleanup = closeOutRun(runId, { intent: 'tree-remove' })
  if (!['released', 'absent'].includes(cleanup.outcome)) {
    throw new Error(`landing tree cleanup ${cleanup.outcome}: ${cleanup.detail}`)
  }
}

function recordLandingTreeFailure(recordId: string, startedAt: string, error: unknown): void {
  db()
    .query("UPDATE run SET status='failed',latency_ms=?,exit_code=1,error=? WHERE record_id=?")
    .run(
      Math.max(0, Date.now() - Date.parse(startedAt)),
      String((error as Error)?.message ?? error),
      recordId,
    )
}

function resolveLandingTarget(runId: string, root: LandingTreeRunRow, latest: LandingTreeRunRow) {
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
  const missingBranch = landingTreeOpeningRefusal({ branch })
  if (missingBranch) throw new Error(`run ${runId}: ${missingBranch}`)
  if (!branch) throw new Error(`run ${runId}: conversation branch resolution failed`)
  const liveTip = gitContext(project.path, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`)
  const plan = resumeTreePlan({
    rootId: root.record_id,
    branch,
    recordedTreeMatches: false,
    hasCreate: false,
    branchTip: liveTip,
    retainedTip: gitContext(
      project.path,
      'rev-parse',
      '--verify',
      `refs/orch/retained/${root.record_id}^{commit}`,
    ),
    recordedTip: root.branch_kept_tip,
  })
  if (plan.action === 'refuse' || plan.action === 'attach-recorded') {
    throw new Error(
      `run ${runId} branch ${branch} has no recoverable tip; restore refs/heads/${branch} or refs/orch/retained/${root.record_id}, then retry`,
    )
  }
  return { project, branch, plan }
}

function finishLandingTreeOpen(
  root: LandingTreeRunRow,
  database: Database,
  recordId: string,
  startedAt: string,
): void {
  adoptCoordinatorRunsForLanding(root, database)
  database
    .query("UPDATE run SET status='ok',latency_ms=?,exit_code=0 WHERE record_id=?")
    .run(Math.max(0, Date.now() - Date.parse(startedAt)), recordId)
}

export function openLandingTree(runId: string, seed?: string): OpenedLandingTree {
  const retryCommand = `${PLATFORM_SLUG} tree open ${runId}${seed ? ` --seed ${seed}` : ''}`
  const { root, latest } = landingTreeSourceRun(runId),
    { project, branch, plan } = resolveLandingTarget(runId, root, latest)
  const tool = resolvedWorktreeTool(project)
  const lifecycle = resolveWorktreeLifecycle(tool)
  const seedDecision = projectSeedPreflight(
    landingTreeSeedRequest({
      requested: seed,
      recordedLaunchSeed: root.launch_seed,
      project,
      tool,
      baseRef: plan.tip,
    }),
  )
  if (seedDecision.refusal) throw new Error(`project ${project.name}: ${seedDecision.refusal}`)
  const effectiveSeed = seedDecision.seed
  validateProjectSeed(project, effectiveSeed)
  let templateBase: string | undefined
  if (lifecycle.form === 'command-templates') {
    const capability = landingTreeCommandCapability(tool!.create!)
    if (!capability.allowed) throw new Error(`${project.name}: ${capability.reason}`)
    templateBase = landingTreeCommandBase(project.settings.trunk)
  }
  assertBranchHasNoAliveOwner({
    branch,
    conversationRootId: null,
    projectId: project.recordId,
    retryCommand,
  })
  refuseExistingLandingTree(project.path, branch, retryCommand)
  const database = writableDb(),
    startedAt = nowIso(),
    prompt = `landing tree for run ${runId}`
  const inserted = db()
    .query(
      `INSERT INTO run (record_id,number,started_at,agent,job,repo,project_record_id,cwd,prompt_sha,prompt_bytes,prompt_head,status,
        session_id,launch_cwd,launch_key,launch_base,launch_seed,stack,evidence_excluded,pid)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'running',?,?,?,?,?,?,?,?) RETURNING record_id`,
    )
    .get(
      newRecordId(),
      nextRunNumber(db()),
      startedAt,
      LANDING_TREE_AGENT,
      LANDING_TREE_JOB,
      project.name,
      project.recordId,
      project.path,
      createHash('sha256').update(prompt).digest('hex').slice(0, 16),
      Buffer.byteLength(prompt),
      prompt,
      sessionId(),
      project.path,
      root.launch_key,
      templateBase ?? plan.tip,
      effectiveSeed ?? null,
      stackAt(project.path),
      LANDING_TREE_EVIDENCE_EXCLUSION,
      process.pid,
    ) as { record_id: string }
  const record = (created: Worktree) =>
    writeTransaction(() => {
      db()
        .query(
          `UPDATE run SET cwd=?,worktree=?,branch=?,minted_branch=NULL,base_commit=?,worktree_source=?,
                  resource_teardown=CASE WHEN ?='recipe' THEN 'pending' ELSE resource_teardown END
           WHERE record_id=?`,
        )
        .run(
          created.path,
          created.path,
          branch,
          plan.tip,
          created.source ?? null,
          created.source ?? null,
          inserted.record_id,
        )
      recordCreatedWorktreeClaims(db(), {
        rootRunId: inserted.record_id,
        runId: inserted.record_id,
        projectId: project.recordId,
        owned: true,
        path: created.path,
        head: plan.tip,
        mintedBranch: null,
        label: String(inserted.record_id),
        claimedAt: nowIso(),
      })
    })
  const recordRecipeResource: RecordRecipeResource = (resource) =>
    writeTransaction(() =>
      recordDatabaseClaim(db(), {
        rootRunId: inserted.record_id,
        runId: inserted.record_id,
        projectId: project.recordId,
        claimedAt: nowIso(),
        provider: resource.provider,
        name: resource.name,
      }),
    )
  const claimRecipeServePort = () =>
    writeTransaction(() =>
      claimRecipePort(db(), {
        rootRunId: inserted.record_id,
        runId: inserted.record_id,
        projectId: project.recordId,
        claimedAt: nowIso(),
        band: RECIPE_PORT_BAND,
      }),
    )
  try {
    const created = withWorktreeCreateLock(project.path, () => {
      assertBranchHasNoAliveOwner({
        branch,
        conversationRootId: null,
        projectId: project.recordId,
        retryCommand,
      })
      prepareResumeBranchIfNeeded(project.path, plan)
      return createWorkerWorktree({
        tool,
        cwd: project.path,
        mainProjectPath: project.path,
        runId: inserted.record_id,
        writes: true,
        readOnlyBase: plan.tip,
        seed: effectiveSeed,
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
        mainStackProject: { recordId: project.recordId, name: project.name },
      })
    })
    const actualBranch = branchOf(created.path)
    const actualTip = gitContext(created.path, 'rev-parse', '--verify', 'HEAD^{commit}')
    const recorded = db()
      .query('SELECT worktree,branch,base_commit,minted_branch FROM run WHERE record_id=?')
      .get(inserted.record_id) as {
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
      inspectTreeOwnership(created.path, project.path, [inserted.record_id]) !== 'owned'
    ) {
      throw new Error(
        `landing tree postcondition failed: expected ${branch} at ${plan.tip} with run ${inserted.record_id} ownership`,
      )
    }
    finishLandingTreeOpen(root, database, inserted.record_id, startedAt)
    return { path: created.path, branch, tip: plan.tip }
  } catch (error) {
    recordLandingTreeFailure(inserted.record_id, startedAt, error)
    try {
      releaseFailedLandingTree(inserted.record_id)
    } catch (cleanupError) {
      throw new Error(
        `${String((error as Error)?.message ?? error)}; ${String((cleanupError as Error)?.message ?? cleanupError)}`,
      )
    }
    throw error
  }
}

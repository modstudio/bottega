// concern: hook-tree
/** Owns creation and explicit teardown of project hook trees. Must not know CLI grammar. */

import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { closeOutRun } from '../close/close-out.ts'
import { db, nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { git } from '../git/git-environment.ts'
import { projectAt, projects, resolvedWorktreeTool, stackAt } from '../project/projects.ts'
import { trackedHookBranch } from '../recipe/tracked-recipe.ts'
import {
  recordCreatedWorktreeClaims,
  runsClaimingWorktreePath,
} from '../resources/resource-claims.ts'
import { acquireRunLease } from '../run/run-lease.ts'
import { nextRunNumber } from '../run/run-number.ts'
import { HOOK_TREE_JOB, isSyntheticLifecycleJob } from '../run/synthetic-lifecycle-job.ts'
import { unownedProjectTreeRemovalRemedy } from '../worktree/snapshotless-tracked-recipe.ts'
import { createWithTool } from '../worktree/worktree-create.ts'
import { resolveWorktreeLifecycle } from '../worktree/worktree-lifecycle.ts'
import { projectSeedPreflight, validateProjectSeed } from '../worktree/worktree-seed.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import { HOOK_TREE_AGENT, hookTreeEvidenceDecision } from './hook-tree.ts'

function canonicalPath(path: string): string {
  try {
    return existsSync(path) ? realpathSync(path) : resolve(path)
  } catch {
    return resolve(path)
  }
}

function registeredProjectContaining(path: string): ReturnType<typeof projects>[number] | null {
  let best: ReturnType<typeof projects>[number] | null = null
  for (const project of projects()) {
    const root = canonicalPath(project.path)
    if (path !== root && !path.startsWith(`${root}${sep}`)) continue
    if (!best || root.length > canonicalPath(best.path).length) best = project
  }
  return best
}

function validateKey(
  tool: NonNullable<ReturnType<typeof resolvedWorktreeTool>>,
  key?: string,
): void {
  const keyPattern = tool.keyPattern ?? '^[A-Z][A-Z0-9]+-[0-9]+$'
  if (key && !new RegExp(keyPattern).test(key)) {
    throw new Error(`key "${key}" does not match ${keyPattern}`)
  }
}

export function hookTreeSeedRequest(input: {
  requested: string | undefined
  project: Parameters<typeof projectSeedPreflight>[0]['project']
  tool: Parameters<typeof projectSeedPreflight>[0]['tool']
  baseRef: string | undefined
}): Parameters<typeof projectSeedPreflight>[0] {
  return {
    requested: input.requested,
    writesRepo: true,
    project: input.project,
    tool: input.tool,
    baseRef: input.baseRef,
  }
}

function recordHookTreeFailure(recordId: string, startedAt: string, detail: string): void {
  db()
    .query(`UPDATE run SET status='failed',latency_ms=?,exit_code=1,error=? WHERE record_id=?`)
    .run(Math.max(0, Date.now() - Date.parse(startedAt)), detail, recordId)
}

export function createHookTree(input: {
  cwd: string
  name: string
  key?: string
  base?: string
  seed?: string
}): string {
  const callerCwd = resolve(input.cwd)
  const project = projectAt(callerCwd)
  if (!project) throw new Error(`${callerCwd} is not inside a registered project`)
  const tool = resolvedWorktreeTool(project)
  if (!tool || resolveWorktreeLifecycle(tool).form !== 'tracked-recipe') {
    throw new Error(
      `project ${project.name} does not use the tracked-recipe worktree lifecycle; no run was created`,
    )
  }
  if (!input.name.trim()) throw new Error('--name must contain text')
  validateKey(tool, input.key)
  const seedDecision = projectSeedPreflight(
    hookTreeSeedRequest({
      requested: input.seed,
      project,
      tool,
      baseRef: input.base,
    }),
  )
  if (seedDecision.refusal) throw new Error(`project ${project.name}: ${seedDecision.refusal}`)
  validateProjectSeed(project, seedDecision.seed)
  const hookBranch = trackedHookBranch({
    tool,
    repoRoot: project.path,
    baseRef: input.base,
    name: input.name,
  })
  try {
    git(['check-ref-format', '--branch', hookBranch], project.path)
  } catch {
    throw new Error(
      `name "${input.name}" produces invalid hook branch "${hookBranch}"; git check-ref-format --branch refused it`,
    )
  }
  writableDb()
  const startedAt = nowIso()
  const prompt = `hook tree ${input.name}`
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
      HOOK_TREE_AGENT,
      HOOK_TREE_JOB,
      project.name,
      project.recordId,
      project.path,
      createHash('sha256').update(prompt).digest('hex').slice(0, 16),
      Buffer.byteLength(prompt),
      input.name,
      sessionId(),
      callerCwd,
      input.key ?? null,
      input.base ?? null,
      seedDecision.seed ?? null,
      stackAt(project.path),
      hookTreeEvidenceDecision().evidenceExcluded,
      process.pid,
    ) as { record_id: string }

  const record = (created: Worktree) => {
    writeTransaction(() => {
      const recorded = db()
        .query(
          `UPDATE run SET cwd=?,worktree=?,branch=?,minted_branch=?,base_commit=?,worktree_source=?,
                  resource_teardown=CASE WHEN ?='recipe' THEN 'pending' ELSE resource_teardown END
           WHERE record_id=?`,
        )
        .run(
          created.path,
          created.path,
          created.branch || null,
          created.mintedBranch ?? null,
          created.base,
          created.source ?? null,
          created.source ?? null,
          inserted.record_id,
        )
      if (recorded.changes !== 1)
        throw new Error(`run ${inserted.record_id} could not record its worktree`)
      recordCreatedWorktreeClaims(db(), {
        rootRunId: inserted.record_id,
        runId: inserted.record_id,
        projectId: project.recordId,
        owned: true,
        path: created.path,
        head: created.base,
        mintedBranch: created.mintedBranch ?? null,
        label: String(inserted.record_id),
        claimedAt: nowIso(),
      })
    })
  }

  let runLease: ReturnType<typeof acquireRunLease> | null = null
  try {
    runLease = acquireRunLease(inserted.record_id)
    const created = createWithTool(
      tool,
      project.path,
      inserted.record_id,
      seedDecision.seed,
      input.key,
      input.base,
      record,
      false,
      undefined,
      undefined,
      undefined,
      hookBranch,
    )
    db()
      .query(`UPDATE run SET status='ok',latency_ms=?,exit_code=0 WHERE record_id=?`)
      .run(Math.max(0, Date.now() - Date.parse(startedAt)), inserted.record_id)
    return created.path
  } catch (error) {
    const detail = String((error as Error)?.message ?? error)
    recordHookTreeFailure(inserted.record_id, startedAt, detail)
    throw error
  } finally {
    runLease?.release()
  }
}

export type HookTreeRemovalResult =
  | { outcome: 'released' }
  | { outcome: 'absent' }
  | { outcome: 'kept'; reason: string }
  | { outcome: 'failed'; detail: string }

export function removeHookTreeResult(requestedPath: string): HookTreeRemovalResult {
  try {
    return removeRecordedHookTree(requestedPath)
  } catch (cause) {
    return { outcome: 'failed', detail: cause instanceof Error ? cause.message : String(cause) }
  }
}

export function absentClaimedHookTreeDecision(input: {
  pathExists: boolean
  hasHistoricalWorktreeClaim: boolean
}): 'absent' | 'refuse' {
  return !input.pathExists && input.hasHistoricalWorktreeClaim ? 'absent' : 'refuse'
}

function removeRecordedHookTree(requestedPath: string): HookTreeRemovalResult {
  const wanted = canonicalPath(requestedPath)
  const recordedOwners = (
    db()
      .query(`SELECT record_id,job,worktree FROM run WHERE worktree IS NOT NULL ORDER BY number`)
      .all() as {
      record_id: string
      job: string
      worktree: string
    }[]
  ).filter((row) => canonicalPath(row.worktree) === wanted)
  const owners = recordedOwners.length
    ? recordedOwners
    : runsClaimingWorktreePath(db(), wanted).filter((row) => isSyntheticLifecycleJob(row.job))
  if (!owners.length) return unownedHookTreeRemovalResult(requestedPath, wanted)
  if (owners.every((row) => !isSyntheticLifecycleJob(row.job))) {
    throw new Error(
      `${requestedPath} belongs to run${owners.length === 1 ? '' : 's'} ${owners.map((row) => row.record_id).join(', ')}, which ${owners.length === 1 ? 'is' : 'are'} not architect tree runs; close ${owners.length === 1 ? 'it' : 'them'} with ${owners.map((row) => `${PLATFORM_SLUG} run close-out ${row.record_id}`).join('; ')}`,
    )
  }
  if (owners.length > 1) {
    throw new Error(
      `${requestedPath} is claimed by more than one lifecycle run: ${owners.map((row) => row.record_id).join(', ')}`,
    )
  }
  writableDb()
  const result = closeOutRun(owners[0]!.record_id, { intent: 'tree-remove' })
  if (result.outcome === 'released') return { outcome: 'released' }
  if (result.outcome === 'absent') return { outcome: 'absent' }
  if (result.outcome === 'held') return { outcome: 'kept', reason: result.detail }
  return { outcome: 'failed', detail: `tree teardown ${result.outcome}: ${result.detail}` }
}

function unownedHookTreeRemovalResult(
  requestedPath: string,
  canonicalRequestedPath: string,
): HookTreeRemovalResult {
  const historicalClaim = db()
    .query(
      `SELECT 1 FROM resource_claim
       WHERE kind='worktree' AND allocation_key IN (?,?) LIMIT 1`,
    )
    .get(requestedPath, canonicalRequestedPath)
  if (
    absentClaimedHookTreeDecision({
      pathExists: existsSync(requestedPath),
      hasHistoricalWorktreeClaim: historicalClaim !== null,
    }) === 'absent'
  ) {
    return { outcome: 'absent' }
  }
  const project = registeredProjectContaining(canonicalRequestedPath)
  if (!project) {
    throw new Error(
      `no orchestrator run records the worktree at ${requestedPath}; no registered project contains it, so its main checkout cannot be established and the orchestrator will not remove it`,
    )
  }
  throw new Error(
    `no orchestrator run records the worktree at ${requestedPath}; ${unownedProjectTreeRemovalRemedy({ treePath: requestedPath, mainCheckoutPath: project.path })}`,
  )
}

export function removeHookTree(requestedPath: string): void {
  const result = removeHookTreeResult(requestedPath)
  if (result.outcome === 'kept') throw new Error(`tree teardown held: ${result.reason}`)
  if (result.outcome === 'failed') throw new Error(result.detail)
}

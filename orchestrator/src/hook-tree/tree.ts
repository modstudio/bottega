// concern: hook-tree
/** Owns creation and explicit teardown of project hook trees. Must not know CLI grammar. */

import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { closeOutRun } from '../close/close-out.ts'
import { db, nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { git } from '../git/git-environment.ts'
import { projectAt, resolvedWorktreeTool, stackAt } from '../project/projects.ts'
import { trackedHookBranch } from '../recipe/tracked-recipe.ts'
import { recordCreatedWorktreeClaims } from '../resources/resource-claims.ts'
import { acquireRunLease } from '../run/run-lease.ts'
import { createWithTool } from '../worktree/worktree-create.ts'
import { resolveWorktreeLifecycle } from '../worktree/worktree-lifecycle.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import { HOOK_TREE_AGENT, HOOK_TREE_JOB, hookTreeEvidenceDecision } from './hook-tree.ts'

function canonicalPath(path: string): string {
  try {
    return existsSync(path) ? realpathSync(path) : resolve(path)
  } catch {
    return resolve(path)
  }
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

export function createHookTree(input: {
  cwd: string
  name: string
  key?: string
  base?: string
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
  const evidence = hookTreeEvidenceDecision()
  const prompt = `hook tree ${input.name}`
  const inserted = db()
    .query(
      `INSERT INTO run
       (started_at,agent,job,repo,project_id,cwd,prompt_sha,prompt_bytes,prompt_head,status,
        session_id,launch_cwd,launch_key,launch_base,stack,evidence_excluded,pid)
       VALUES (?,?,?,?,?,?,?,?,?,'running',?,?,?,?,?,?,?) RETURNING id`,
    )
    .get(
      startedAt,
      HOOK_TREE_AGENT,
      HOOK_TREE_JOB,
      project.name,
      project.id,
      project.path,
      createHash('sha256').update(prompt).digest('hex').slice(0, 16),
      Buffer.byteLength(prompt),
      input.name,
      sessionId(),
      callerCwd,
      input.key ?? null,
      input.base ?? null,
      stackAt(project.path),
      evidence.evidenceExcluded,
      process.pid,
    ) as { id: number }

  const record = (created: Worktree) => {
    writeTransaction(() => {
      const recorded = db()
        .query(
          `UPDATE run SET cwd=?,worktree=?,branch=?,minted_branch=?,base_commit=?,worktree_source=?
           WHERE id=?`,
        )
        .run(
          created.path,
          created.path,
          created.branch || null,
          created.mintedBranch ?? null,
          created.base,
          created.source ?? null,
          inserted.id,
        )
      if (recorded.changes !== 1)
        throw new Error(`run ${inserted.id} could not record its worktree`)
      recordCreatedWorktreeClaims(db(), {
        rootRunId: inserted.id,
        runId: inserted.id,
        projectId: project.id,
        owned: true,
        path: created.path,
        head: created.base,
        mintedBranch: created.mintedBranch ?? null,
        label: String(inserted.id),
        claimedAt: nowIso(),
      })
    })
  }

  let runLease: ReturnType<typeof acquireRunLease> | null = null
  try {
    runLease = acquireRunLease(inserted.id)
    const created = createWithTool(
      tool,
      project.path,
      inserted.id,
      undefined,
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
      .query(`UPDATE run SET status='ok',latency_ms=?,exit_code=0 WHERE id=?`)
      .run(Math.max(0, Date.now() - Date.parse(startedAt)), inserted.id)
    return created.path
  } catch (error) {
    const detail = String((error as Error)?.message ?? error)
    db()
      .query(`UPDATE run SET status='failed',latency_ms=?,exit_code=1,error=? WHERE id=?`)
      .run(Math.max(0, Date.now() - Date.parse(startedAt)), detail, inserted.id)
    throw error
  } finally {
    runLease?.release()
  }
}

export function removeHookTree(requestedPath: string): void {
  const wanted = canonicalPath(requestedPath)
  const owners = (
    db().query(`SELECT id,job,worktree FROM run WHERE worktree IS NOT NULL ORDER BY id`).all() as {
      id: number
      job: string
      worktree: string
    }[]
  ).filter((row) => canonicalPath(row.worktree) === wanted)
  if (!owners.length || owners.every((row) => row.job !== HOOK_TREE_JOB)) {
    throw new Error(`${requestedPath} is not a hook tree`)
  }
  if (owners.length > 1) {
    throw new Error(
      `${requestedPath} is claimed by more than one hook run: ${owners.map((row) => row.id).join(', ')}`,
    )
  }
  if (owners[0]!.job !== HOOK_TREE_JOB) throw new Error(`${requestedPath} is not a hook tree`)
  writableDb()
  const result = closeOutRun(owners[0]!.id, { intent: 'tree-remove' })
  if (!['released', 'absent'].includes(result.outcome)) {
    throw new Error(`hook tree teardown ${result.outcome}: ${result.detail}`)
  }
}

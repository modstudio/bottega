// concern: filed-issue before-measurement lifecycle
/** Owns the temporary cross-project checkout used to prove the defect before its fix. */

import { createHash } from 'node:crypto'
import { newRecordId } from '../../../shared/record-id.ts'
import { db, nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { repoRootOf } from '../git/git-environment.ts'
import { type Project, resolvedWorktreeTool, stackAt } from '../project/projects.ts'
import { recordCreatedWorktreeClaims } from '../resources/resource-claims.ts'
import { nextRunNumber } from '../run/run-number.ts'
import { ISSUE_BEFORE_TREE_JOB } from '../run/synthetic-lifecycle-job.ts'
import { createReadOnlyWorktreeForTool, readOnlyWorktreeSource } from '../worktree/worktree.ts'
import { readOnlyWorktreePath } from '../worktree/worktree-readonly.ts'
import type { Worktree } from '../worktree/worktree-types.ts'

export type IssueBeforeTree = { runId: string; worktree: Worktree }

type IssueBeforeTreeDependencies = {
  createWorktree?: typeof createReadOnlyWorktreeForTool
  /** The main checkout whose objects the read-only clone borrows; null means there is none. */
  repoRoot?: (target: Project) => string | null
}

export function createIssueBeforeTree(
  target: Project,
  base: string,
  dependencies: IssueBeforeTreeDependencies = {},
): IssueBeforeTree {
  writableDb()
  const prompt = `issue before measurement for ${target.name}`
  const inserted = db()
    .query<{ record_id: string }, (string | number | null)[]>(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,repo,project_record_id,cwd,prompt_sha,prompt_bytes,prompt_head,status,
        session_id,launch_cwd,launch_base,stack,evidence_excluded,pid)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'running',?,?,?,?,?,?) RETURNING record_id`,
    )
    .get(
      newRecordId(),
      nextRunNumber(db()),
      nowIso(),
      '(architect)',
      ISSUE_BEFORE_TREE_JOB,
      target.name,
      target.recordId,
      target.path,
      createHash('sha256').update(prompt).digest('hex').slice(0, 16),
      Buffer.byteLength(prompt),
      prompt,
      sessionId(),
      target.path,
      base,
      stackAt(target.path),
      'issue before-measurement lifecycle row; not agent execution',
      process.pid,
    )
  if (!inserted) throw new Error('issue before-measurement lifecycle run was not inserted')
  const tool = resolvedWorktreeTool(target)
  const recordClaims = (path: string, head: string) =>
    recordCreatedWorktreeClaims(db(), {
      rootRunId: inserted.record_id,
      runId: inserted.record_id,
      projectId: target.recordId,
      owned: true,
      path,
      head,
      mintedBranch: null,
      label: inserted.record_id,
      claimedAt: nowIso(),
    })
  /**
   * Record the tree this run owns: the intended path before it exists, the
   * created facts after.
   *
   * Creation and cleanup can both fail, and a tree nobody recorded is one no
   * sweep can release; the intended path and the lifecycle that will own it
   * are the orchestrator's own choice, known before the creator runs. The
   * success callback below then writes the same facts creation established.
   */
  const recordTree = (facts: { path: string; base: string; source: Worktree['source'] | null }) =>
    writeTransaction(() => {
      const recorded = db()
        .query(
          `UPDATE run SET cwd=?,worktree=?,branch=NULL,minted_branch=NULL,base_commit=?,worktree_source=?
           WHERE record_id=?`,
        )
        .run(facts.path, facts.path, facts.base, facts.source ?? null, inserted.record_id)
      if (recorded.changes !== 1)
        throw new Error(`run ${inserted.record_id} could not record its before-measurement tree`)
      recordClaims(facts.path, facts.base)
    })
  try {
    const resolveRoot =
      dependencies.repoRoot ?? ((candidate: Project) => repoRootOf(candidate.path))
    const repoRoot = resolveRoot(target)
    if (!repoRoot)
      throw new Error(
        `issue before-measurement checkout for run ${inserted.record_id} needs a git repository: ${target.path} is not one`,
      )
    recordTree({
      path: readOnlyWorktreePath(repoRoot, inserted.record_id),
      base,
      source: readOnlyWorktreeSource(tool),
    })
    return {
      runId: inserted.record_id,
      worktree: (dependencies.createWorktree ?? createReadOnlyWorktreeForTool)({
        tool,
        cwd: target.path,
        runId: inserted.record_id,
        readOnlyBase: base,
        record: (created) =>
          recordTree({ path: created.path, base: created.base, source: created.source ?? null }),
      }),
    }
  } catch (error) {
    db()
      .query("UPDATE run SET status='failed',latency_ms=0,exit_code=1,error=? WHERE record_id=?")
      .run(String(error), inserted.record_id)
    throw error
  }
}

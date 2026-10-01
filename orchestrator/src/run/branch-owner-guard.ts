// concern: branch-owner-guard
/** Guards worktree creation against another live conversation on the branch. */

import { db } from '../database/db.ts'
import { JOBS } from '../jobs/jobs.ts'
import {
  aliveBranchConversationOwner,
  type BranchConversationRow,
} from './branch-conversation-owner.ts'

export function jobWritesRepo(
  job: string,
  jobs: Readonly<Record<string, { needs: { writesRepo?: boolean } }>>,
): boolean {
  const definition = jobs[job]
  return definition === undefined ? true : definition.needs.writesRepo === true
}

function aliveOwnerOnBranch(input: {
  branch: string
  conversationRootId: number | null
  projectId: number | null
  projectName: string | null
}): BranchConversationRow | null {
  const rows = db()
    .query(
      `SELECT id, parent_run_id, status, branch, job FROM run
       WHERE branch=? AND status IN ('running','asking')
         AND (project_id=? OR (project_id IS NULL AND repo=?))
       ORDER BY id`,
    )
    .all(input.branch, input.projectId, input.projectName) as Omit<
    BranchConversationRow,
    'writesRepo'
  >[]
  const declaredRows = rows.map((row) => ({
    ...row,
    writesRepo: jobWritesRepo(row.job, JOBS),
  }))
  return aliveBranchConversationOwner(declaredRows, input.branch, input.conversationRootId)
}

export function assertBranchHasNoAliveOwner(input: {
  branch: string | undefined
  conversationRootId: number | null
  projectId: number | null
  projectName: string | null
  retryCommand?: string
}): void {
  const branch = input.branch
  if (!branch) return
  const owner = aliveOwnerOnBranch({ ...input, branch })
  if (!owner) return
  throw new Error(
    `refusing to create a worktree on branch ${input.branch}: ` +
      `run ${owner.id} (${owner.status}) in another conversation is alive\n` +
      `invariant: Two live writer conversations never share one task branch.\n` +
      (input.retryCommand
        ? `cleared by: wait for or stop run ${owner.id}, then retry ${input.retryCommand}`
        : `cleared by: wait for or stop run ${owner.id}, or dispatch with an explicit --base ` +
          `to cut a separate branch`),
  )
}

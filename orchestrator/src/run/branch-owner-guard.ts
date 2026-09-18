// concern: branch-owner-guard
/** Guards worktree creation against another live conversation on the branch. */

import { db } from '../database/db.ts'
import {
  aliveBranchConversationOwner,
  type BranchConversationRow,
} from './branch-conversation-owner.ts'

function aliveOwnerOnBranch(input: {
  branch: string
  conversationRootId: number | null
  projectId: number | null
  projectName: string | null
}): BranchConversationRow | null {
  const rows = db()
    .query(
      `SELECT id, parent_run_id, status, branch FROM run
       WHERE branch=? AND status IN ('running','asking')
         AND (project_id=? OR (project_id IS NULL AND repo=?))
       ORDER BY id`,
    )
    .all(input.branch, input.projectId, input.projectName) as BranchConversationRow[]
  return aliveBranchConversationOwner(rows, input.branch, input.conversationRootId)
}

export function assertBranchHasNoAliveOwner(input: {
  branch: string | undefined
  conversationRootId: number | null
  projectId: number | null
  projectName: string | null
}): void {
  const branch = input.branch
  if (!branch) return
  const owner = aliveOwnerOnBranch({ ...input, branch })
  if (!owner) return
  throw new Error(
    `refusing to create a worktree on branch ${input.branch}: ` +
      `run ${owner.id} (${owner.status}) in another conversation is alive\n` +
      `invariant: Two live writer conversations never share one task branch.\n` +
      `cleared by: wait for or stop run ${owner.id}, or dispatch with an explicit --base ` +
      `to cut a separate branch`,
  )
}

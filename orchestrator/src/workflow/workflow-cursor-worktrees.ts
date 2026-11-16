// concern: workflow cursor worktree read
/** Reads only the worktree arguments held by open workflow cursors. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { taskFlowReadStore } from './task-flow-store.ts'

export type OpenCursorWorktree = {
  number: number
  workflow: string
  project: string
  worktree: string
}

/** Read the claim handles carried by one cursor without trusting stored argument JSON. */
function workflowCursorStoredArgs(args: string): Record<string, unknown> | null {
  try {
    return JSON.parse(args) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Read the branch and worktree carried by one cursor as normalized optional handles. */
export function workflowCursorBranchAndWorktree(args: string): {
  branch: string | null
  worktree: string | null
} {
  const parsed = workflowCursorStoredArgs(args)
  const handle = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim() : null
  return {
    branch: handle(parsed?.branch),
    worktree: handle(parsed?.worktree),
  }
}

export function workflowCursorClaimHandles(args: string): string[] {
  const handles = workflowCursorBranchAndWorktree(args)
  return [handles.worktree, handles.branch].filter((value): value is string => value !== null)
}

export async function openCursorWorktrees(
  database: Database = db(),
): Promise<OpenCursorWorktree[]> {
  const rows = await taskFlowReadStore(database).openStageWorktrees()
  return rows.flatMap((row) => {
    const worktree = workflowCursorStoredArgs(row.args)?.worktree
    return worktree && typeof worktree === 'string' && worktree.trim()
      ? [{ number: row.number, workflow: row.workflow, project: row.project, worktree }]
      : []
  })
}

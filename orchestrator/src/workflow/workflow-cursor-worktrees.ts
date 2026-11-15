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

export function workflowCursorClaimHandles(args: string): string[] {
  const parsed = workflowCursorStoredArgs(args)
  return parsed
    ? [parsed.worktree, parsed.branch].filter(
      (value): value is string => typeof value === 'string' && Boolean(value.trim()),
    )
    : []
}

export async function openCursorWorktrees(
  database: Database = db(),
): Promise<OpenCursorWorktree[]> {
  const rows = await taskFlowReadStore(database).openStageWorktrees()
  return rows.flatMap((row) => {
    const worktree = workflowCursorStoredArgs(row.args)?.worktree
    return worktree
      && typeof worktree === 'string'
      && worktree.trim()
      ? [{ number: row.number, workflow: row.workflow, project: row.project, worktree }]
      : []
  })
}

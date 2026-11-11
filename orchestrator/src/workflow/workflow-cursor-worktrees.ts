// concern: workflow cursor worktree read
/** Reads only the worktree arguments held by open workflow cursors. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { taskFlowStore } from './task-flow-store.ts'

export type OpenCursorWorktree = {
  number: number
  workflow: string
  project: string
  worktree: string
}

export function openCursorWorktrees(database: Database = db()): OpenCursorWorktree[] {
  const rows = taskFlowStore(database).openStageWorktrees()
  return rows.flatMap((row) => {
    try {
      const worktree = (JSON.parse(row.args) as Record<string, unknown>).worktree
      return typeof worktree === 'string' && worktree.trim()
        ? [{ number: row.number, workflow: row.workflow, project: row.project, worktree }]
        : []
    } catch {
      return []
    }
  })
}

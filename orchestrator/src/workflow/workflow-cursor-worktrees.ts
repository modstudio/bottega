// concern: workflow cursor worktree read
/** Reads only the worktree arguments held by open workflow cursors. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'

export type OpenCursorWorktree = { project: string; worktree: string }

export function openCursorWorktrees(database: Database = db()): OpenCursorWorktree[] {
  const rows = database
    .query<{ project: string; args: string }, []>(
      `SELECT project,args FROM workflow_cursor
       WHERE state NOT IN ('done','abandoned')
       ORDER BY number`,
    )
    .all()
  return rows.flatMap((row) => {
    const worktree = (JSON.parse(row.args) as Record<string, unknown>).worktree
    return typeof worktree === 'string' && worktree.trim()
      ? [{ project: row.project, worktree }]
      : []
  })
}

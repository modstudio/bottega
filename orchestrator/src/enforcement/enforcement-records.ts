// concern: enforcement-records
/** Selects and reads the newest successful gate observation for each category. */

import type { Database } from 'bun:sqlite'
import { isAbsolute, relative } from 'node:path'
import { db } from '../database/db.ts'

export type CategoryExecutionRow = {
  category: string
  wallMs: number
  remaining: number | null
  finishedAt: string
  gateId: number
  gateExitCode: number
  headCommit: string | null
  cwd: string | null
}

export type CategoryExecution = Pick<
  CategoryExecutionRow,
  'wallMs' | 'remaining' | 'finishedAt'
>

function isInProject(projectPath: string, cwd: string | null): boolean {
  if (!cwd) return false
  const fromProject = relative(projectPath, cwd)
  return fromProject === '' || (!fromProject.startsWith('..') && !isAbsolute(fromProject))
}

export function newestCategoryExecutions(
  rows: readonly CategoryExecutionRow[],
  projectPath: string,
): Map<string, CategoryExecution> {
  const selected = new Map<string, CategoryExecutionRow>()
  for (const row of rows) {
    if (row.gateExitCode !== 0 || row.headCommit === null || !isInProject(projectPath, row.cwd)) {
      continue
    }
    const current = selected.get(row.category)
    if (
      !current ||
      row.finishedAt > current.finishedAt ||
      (row.finishedAt === current.finishedAt && row.gateId > current.gateId)
    ) {
      selected.set(row.category, row)
    }
  }
  return new Map(
    [...selected].map(([category, row]) => [
      category,
      {
        wallMs: row.wallMs,
        remaining: row.remaining,
        finishedAt: row.finishedAt,
      },
    ]),
  )
}

export function categoryExecutionsForProject(
  projectPath: string,
  database: Database = db(),
): Map<string, CategoryExecution> {
  const rows = database
    .query(
      `SELECT c.category,c.wall_ms wallMs,c.remaining_count remaining,
              g.finished_at finishedAt,g.id gateId,g.exit_code gateExitCode,
              g.head_commit headCommit,g.cwd
         FROM check_execution c JOIN gate_execution g ON g.id=c.gate_execution_id
        WHERE c.category IS NOT NULL AND g.finished_at IS NOT NULL`,
    )
    .all() as CategoryExecutionRow[]
  return newestCategoryExecutions(rows, projectPath)
}

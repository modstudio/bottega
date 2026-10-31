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
  gateRecordId: string
  gateExitCode: number
  headCommit: string | null
  cwd: string | null
}

export type CategoryExecution = Pick<CategoryExecutionRow, 'wallMs' | 'remaining' | 'finishedAt'>

export type RefilledCategoryExecution = {
  category: string
  remaining: number
  finishedAt: string
  lastZeroFinishedAt: string
}

function isInProject(projectPath: string, cwd: string | null): boolean {
  if (!cwd) return false
  const fromProject = relative(projectPath, cwd)
  return fromProject === '' || (!fromProject.startsWith('..') && !isAbsolute(fromProject))
}

function eligibleCategoryExecutionRows(
  rows: readonly CategoryExecutionRow[],
  projectPath: string,
): CategoryExecutionRow[] {
  return rows.filter(
    (row) => row.gateExitCode === 0 && row.headCommit !== null && isInProject(projectPath, row.cwd),
  )
}

function compareCategoryExecutionRecency(
  left: CategoryExecutionRow,
  right: CategoryExecutionRow,
): number {
  return (
    left.finishedAt.localeCompare(right.finishedAt) ||
    left.gateRecordId.localeCompare(right.gateRecordId)
  )
}

export function newestCategoryExecutions(
  rows: readonly CategoryExecutionRow[],
  projectPath: string,
): Map<string, CategoryExecution> {
  const selected = new Map<string, CategoryExecutionRow>()
  for (const row of eligibleCategoryExecutionRows(rows, projectPath)) {
    const current = selected.get(row.category)
    if (!current || compareCategoryExecutionRecency(row, current) > 0) {
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

/** Find categories whose newest eligible count is positive after an earlier zero. */
export function refilledCategoryExecutions(
  rows: readonly CategoryExecutionRow[],
  projectPath: string,
): RefilledCategoryExecution[] {
  const histories = new Map<string, CategoryExecutionRow[]>()
  for (const row of eligibleCategoryExecutionRows(rows, projectPath)) {
    if (row.remaining === null) continue
    const history = histories.get(row.category) ?? []
    history.push(row)
    histories.set(row.category, history)
  }
  return [...histories].flatMap(([category, history]) => {
    history.sort(compareCategoryExecutionRecency)
    const newest = history.at(-1)!
    const remaining = newest.remaining
    if (remaining === null || remaining === 0) return []
    const lastZero = history.findLast((row) => row !== newest && row.remaining === 0)
    if (!lastZero) return []
    return [
      {
        category,
        remaining,
        finishedAt: newest.finishedAt,
        lastZeroFinishedAt: lastZero.finishedAt,
      },
    ]
  })
}

/** Read category records with the fields needed by eligibility and history decisions. */
export function categoryExecutionRows(database: Database = db()): CategoryExecutionRow[] {
  return database
    .query(
      `SELECT c.category,c.wall_ms wallMs,c.remaining_count remaining,
              g.finished_at finishedAt,g.record_id gateRecordId,g.exit_code gateExitCode,
              g.head_commit headCommit,g.cwd
         FROM check_execution c JOIN gate_execution g ON g.record_id=c.gate_execution_record_id
        WHERE c.category IS NOT NULL AND g.purpose='gate' AND g.finished_at IS NOT NULL
        ORDER BY g.finished_at,g.record_id`,
    )
    .all() as CategoryExecutionRow[]
}

export function categoryExecutionsForProject(
  projectPath: string,
  database: Database = db(),
): Map<string, CategoryExecution> {
  return newestCategoryExecutions(categoryExecutionRows(database), projectPath)
}

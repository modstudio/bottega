// concern: workflow cursor listing
/** Lists open cursors with their next step and unresolved floor obligations. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { projectAt } from '../project/projects.ts'
import { cursorAutonomy } from './workflow-cursor-autonomy.ts'
import { renderWorkflowCursorLine } from './workflow-cursor-format.ts'
import {
  LISTED_CURSOR_COLUMNS,
  type SelectableCursorRow,
  workflowCursorProjectScope,
} from './workflow-cursor-selection.ts'
import { openWorkflowObligations } from './workflow-floor-evidence.ts'
import { composeWorkflow } from './workflows.ts'

export type CursorListOptions = {
  session?: string
  all?: boolean
  project?: string
  cwd?: string
}

type ListedCursorRow = SelectableCursorRow & {
  closed: string
  question: string | null
  total_steps: number
  created_at: string
  updated_at: string
}

export function listWorkflowCursors(
  options: CursorListOptions = {},
  d: Database = db(),
): Array<ListedCursorRow & { next_slug: string; line: string }> {
  const cwd = options.cwd ?? process.cwd()
  const cwdProject =
    options.all || options.project || options.session ? undefined : projectAt(cwd)?.name
  const project = workflowCursorProjectScope(options, cwdProject, cwd)
  const clauses = [`state NOT IN ('done','abandoned')`]
  const values: string[] = []
  if (project) {
    clauses.push('project_record_id=(SELECT record_id FROM project WHERE name=?)')
    values.push(project)
  }
  if (options.session) {
    clauses.push('session_id=?')
    values.push(options.session)
  }
  const rows = d
    .query(
      `SELECT ${LISTED_CURSOR_COLUMNS} FROM workflow_cursor WHERE ${clauses.join(' AND ')} ORDER BY updated_at,number`,
    )
    .all(...values) as ListedCursorRow[]
  return rows.map((row) => {
    const composition = composeWorkflow(
      row.workflow_slug,
      row.project,
      row.mode_slug,
      JSON.parse(row.args),
      d,
      { version: row.workflow_version, catalogueVersion: row.catalogue_version },
      cursorAutonomy(row),
    )
    const open = openWorkflowObligations(row.record_id, d)
    const listed = {
      ...row,
      next_slug: composition.steps[row.ordinal + 1]?.slug ?? 'finished',
      obligations: open.map((item) => `${item.id}(${item.stepSlug}:${item.floor})`).join(','),
    }
    return { ...listed, line: renderWorkflowCursorLine(listed) }
  })
}

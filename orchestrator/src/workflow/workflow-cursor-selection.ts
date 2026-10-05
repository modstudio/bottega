// concern: workflow cursor selection
/** Selects one open workflow cursor by public handle or declared identity. */
import type { Database } from 'bun:sqlite'
import type { CursorState } from './workflow-cursor-transition.ts'

export type WorkflowCursorIdentity = {
  project?: string
  workflow?: string
  mode?: string
  key?: string
}

export type SelectableCursorRow = {
  id: number
  project: string
  workflow_slug: string
  mode_slug: string
  workflow_key: string
  instance_id: string
  session_id: string | null
  ordinal: number
  step_slug: string
  state: CursorState
}

const mismatch = (cursor: number, name: string, supplied: string, stored: string): never => {
  throw new Error(
    `cursor ${cursor} ${name} mismatch: supplied "${supplied}", cursor has "${stored}"`,
  )
}

export function cursorCandidate(row: SelectableCursorRow): string {
  return `cursor ${row.id}, ${row.workflow_key || 'unassigned'}, ${row.workflow_slug} ${row.mode_slug}, step ${row.ordinal + 1} ${row.step_slug}`
}

export function selectWorkflowCursor(
  identity: WorkflowCursorIdentity,
  cursor: number | undefined,
  ownerSession: string | null | undefined,
  d: Database,
): SelectableCursorRow | null {
  if (cursor !== undefined) {
    const row = d.query('SELECT * FROM workflow_cursor WHERE id=?').get(cursor) as
      | SelectableCursorRow
      | null
    if (!row) throw new Error(`workflow cursor ${cursor} does not exist`)
    if (identity.project && identity.project !== row.project)
      mismatch(cursor, 'project', identity.project, row.project)
    if (identity.workflow && identity.workflow !== row.workflow_slug)
      mismatch(cursor, 'workflow', identity.workflow, row.workflow_slug)
    if (identity.mode && identity.mode !== row.mode_slug)
      mismatch(cursor, 'mode', identity.mode, row.mode_slug)
    if (identity.key && identity.key !== row.workflow_key)
      mismatch(cursor, 'key', identity.key, row.workflow_key || 'unassigned')
    return row
  }
  if (!identity.project || !identity.workflow || !identity.mode) return null
  if (identity.key) {
    return d
      .query(
        `SELECT * FROM workflow_cursor
         WHERE project=? AND workflow_slug=? AND mode_slug=? AND workflow_key=?
           AND state NOT IN ('done','abandoned') ORDER BY id LIMIT 1`,
      )
      .get(identity.project, identity.workflow, identity.mode, identity.key) as
      | SelectableCursorRow
      | null
  }
  if (!ownerSession) return null
  const rows = d
    .query(
      `SELECT * FROM workflow_cursor
       WHERE project=? AND workflow_slug=? AND mode_slug=? AND workflow_key=''
         AND session_id=? AND state NOT IN ('done','abandoned') ORDER BY id`,
    )
    .all(identity.project, identity.workflow, identity.mode, ownerSession) as SelectableCursorRow[]
  if (rows.length > 1) {
    throw new Error(
      `more than one open keyless workflow cursor matches; pass a cursor handle:\n${rows.map(cursorCandidate).join('\n')}`,
    )
  }
  return rows[0] ?? null
}

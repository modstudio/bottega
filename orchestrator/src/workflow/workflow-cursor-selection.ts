// concern: workflow cursor selection
/** Selects one open workflow cursor by public handle or declared identity. */
import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { workflowKeyOf } from './workflow-cursor-arguments.ts'
import type { CursorState } from './workflow-cursor-transition.ts'
import { resolveWorkflowMode, showWorkflow } from './workflows.ts'

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

function cursorCandidate(row: SelectableCursorRow): string {
  return `cursor ${row.id}, ${row.workflow_key || 'unassigned'}, ${row.workflow_slug} ${row.mode_slug}, step ${row.ordinal + 1} ${row.step_slug}`
}

function validateIdentity(
  row: SelectableCursorRow,
  identity: WorkflowCursorIdentity,
): SelectableCursorRow {
  if (identity.project && identity.project !== row.project)
    mismatch(row.id, 'project', identity.project, row.project)
  if (identity.workflow && identity.workflow !== row.workflow_slug)
    mismatch(row.id, 'workflow', identity.workflow, row.workflow_slug)
  if (identity.mode && identity.mode !== row.mode_slug)
    mismatch(row.id, 'mode', identity.mode, row.mode_slug)
  if (identity.key && identity.key !== row.workflow_key)
    mismatch(row.id, 'key', identity.key, row.workflow_key || 'unassigned')
  return row
}

function selectByHandle(
  cursor: number,
  identity: WorkflowCursorIdentity,
  d: Database,
): SelectableCursorRow {
  const row = d
    .query('SELECT * FROM workflow_cursor WHERE id=?')
    .get(cursor) as SelectableCursorRow | null
  if (!row) throw new Error(`workflow cursor ${cursor} does not exist`)
  validateIdentity(row, identity)
  if (row.state === 'done' || row.state === 'abandoned')
    throw new Error(
      `cursor ${row.id} is ${row.state}; a new run is opened by fetching step 1 without a handle`,
    )
  return row
}

export function selectWorkflowCursor(
  identity: WorkflowCursorIdentity,
  cursor: number | undefined,
  ownerSession: string | null | undefined,
  d: Database,
): SelectableCursorRow | null {
  if (cursor !== undefined) return selectByHandle(cursor, identity, d)
  if (!identity.project || !identity.workflow || !identity.mode) return null
  if (identity.key) {
    return d
      .query(
        `SELECT * FROM workflow_cursor
         WHERE project=? AND workflow_slug=? AND mode_slug=? AND workflow_key=?
           AND instance_id='' ORDER BY id DESC LIMIT 1`,
      )
      .get(
        identity.project,
        identity.workflow,
        identity.mode,
        identity.key,
      ) as SelectableCursorRow | null
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

export type CursorModeContext = { session?: string | null; instance?: string }

export function resolveWorkflowCursorMode(
  slug: string,
  project: string,
  requested: string | undefined,
  args: Record<string, string>,
  context: CursorModeContext,
  caller: string,
  remedy: string,
  d: Database = db(),
  cursor?: number,
): string {
  const key = workflowKeyOf(args)
  if (cursor !== undefined)
    return selectByHandle(
      cursor,
      { project, workflow: slug, ...(requested ? { mode: requested } : {}), key: key || undefined },
      d,
    ).mode_slug
  if (requested) return requested
  const rows = d
    .query(
      `SELECT DISTINCT mode_slug FROM workflow_cursor
       WHERE project=? AND workflow_slug=? AND workflow_key=?
         AND ${key ? "instance_id=''" : 'session_id=?'}
         AND state NOT IN ('done','abandoned') ORDER BY mode_slug`,
    )
    .all(...(key ? [project, slug, key] : [project, slug, key, context.session ?? ''])) as {
    mode_slug: string
  }[]
  if (rows.length === 1) return rows[0]!.mode_slug
  if (rows.length > 1)
    throw new Error(
      `${caller} cannot resolve a mode for workflow "${slug}"; active cursor modes: ` +
        `${rows.map(({ mode_slug }) => mode_slug).join(', ')}; ${remedy}`,
    )
  const definition = showWorkflow(slug, undefined, d).definition
  const mode = resolveWorkflowMode(definition)
  if (mode) return mode.slug
  throw new Error(
    `${caller} cannot resolve a default mode for workflow "${slug}"; ` +
      `modes: ${definition.modes.map(({ slug: modeSlug }) => modeSlug).join(', ')}; ${remedy}`,
  )
}

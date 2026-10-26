// concern: workflow cursor selection
/** Selects one open workflow cursor by public handle or declared identity. */
import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { db, sessionId } from '../database/db.ts'
import {
  type HubTaskReader,
  resolveHubTaskReference,
} from '../run/run-task-linking.ts'
import { workflowKeyOf } from './workflow-cursor-arguments.ts'
import { hasClosedStep } from './workflow-cursor-trail.ts'
import type { CursorState } from './workflow-cursor-transition.ts'
import { resolveWorkflowMode, showResolvedWorkflow } from './workflows.ts'

/** The persisted cursor columns a listed cursor carries; storage identity is not one of them. */
export const LISTED_CURSOR_COLUMNS =
  'number id,record_id,project,workflow_slug,mode_slug,workflow_key,task_record_id,instance_id,session_id,ordinal,step_slug,state,workflow_version_record_id,catalogue_version_record_id,(SELECT n FROM workflow_version WHERE record_id=workflow_version_record_id) workflow_version,(SELECT n FROM step_catalogue_version WHERE record_id=catalogue_version_record_id) catalogue_version,args,autonomy,closed,question,total_steps,created_at,updated_at,enforcement'

export type WorkflowCursorSelector = {
  project?: string
  workflow?: string
  mode?: string
  key?: string
}

export type WorkflowCursorContext = {
  session?: string | null
  instance?: string
  taskRecordId?: string | null
}

const MCP_INSTANCE = randomUUID()

export const mcpWorkflowCursorContext = (): WorkflowCursorContext => ({
  session: sessionId(),
  instance: MCP_INSTANCE,
})

export const cliWorkflowCursorContext = (): WorkflowCursorContext => ({ session: sessionId() })

export async function resolveWorkflowCursorContext(
  project: string,
  key: string | null | undefined,
  context: WorkflowCursorContext,
  reader?: HubTaskReader,
): Promise<WorkflowCursorContext> {
  if (!key) return { ...context, taskRecordId: null }
  const task = await resolveHubTaskReference(project, key, reader)
  return { ...context, taskRecordId: task?.record_id ?? null }
}

export function workflowCursorProjectScope(
  options: { all?: boolean; project?: string; session?: string },
  cwdProject: string | undefined,
  cwd: string,
): string | undefined {
  if (options.all || (options.session && !options.project)) return undefined
  if (options.project) return options.project
  if (cwdProject) return cwdProject
  throw new Error(`cannot list workflow cursors from ${cwd}: pass --project, --session or --all`)
}

export type SelectableCursorRow = {
  id: number
  record_id: string
  project: string
  workflow_slug: string
  mode_slug: string
  workflow_key: string
  task_record_id: string | null
  instance_id: string
  session_id: string | null
  ordinal: number
  step_slug: string
  state: CursorState
  workflow_version_record_id: string
  catalogue_version_record_id: string
  workflow_version: number
  catalogue_version: number
  args: string
  autonomy: string | null
}

const mismatch = (cursor: number, name: string, supplied: string, stored: string): never => {
  throw new Error(
    `cursor ${cursor} ${name} mismatch: supplied "${supplied}", cursor has "${stored}"`,
  )
}

function cursorCandidate(row: SelectableCursorRow): string {
  return `cursor ${row.id}, ${row.workflow_key || 'unassigned'}, ${row.workflow_slug} ${row.mode_slug}, step ${row.ordinal + 1} ${row.step_slug}`
}

function refuseAmbiguousKeylessCursors(rows: SelectableCursorRow[]): never {
  throw new Error(
    `more than one open keyless workflow cursor matches; pass a cursor handle:\n${rows.map(cursorCandidate).join('\n')}`,
  )
}

function validateIdentity(
  row: SelectableCursorRow,
  identity: WorkflowCursorSelector,
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
  identity: WorkflowCursorSelector,
  d: Database,
): SelectableCursorRow {
  const row = d
    .query(`SELECT ${LISTED_CURSOR_COLUMNS} FROM workflow_cursor WHERE number=?`)
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
  identity: WorkflowCursorSelector,
  cursor: number | undefined,
  ownerSession: string | null | undefined,
  d: Database,
  taskRecordId?: string | null,
): SelectableCursorRow | null {
  if (cursor !== undefined) return selectByHandle(cursor, identity, d)
  if (!identity.project || !identity.workflow || !identity.mode) return null
  if (identity.key) {
    return d
      .query(
        `SELECT ${LISTED_CURSOR_COLUMNS} FROM workflow_cursor
         WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
           AND workflow_slug=? AND mode_slug=? AND task_record_id=?
           AND instance_id='' ORDER BY number DESC LIMIT 1`,
      )
      .get(
        identity.project,
        identity.workflow,
        identity.mode,
        taskRecordId ?? null,
      ) as SelectableCursorRow | null
  }
  if (!ownerSession) return null
  const rows = d
    .query(
      `SELECT ${LISTED_CURSOR_COLUMNS} FROM workflow_cursor
       WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
         AND workflow_slug=? AND mode_slug=? AND workflow_key=''
         AND session_id=? AND state NOT IN ('done','abandoned') ORDER BY number`,
    )
    .all(identity.project, identity.workflow, identity.mode, ownerSession) as SelectableCursorRow[]
  if (rows.length > 1) {
    refuseAmbiguousKeylessCursors(rows)
  }
  return rows[0] ?? null
}

export function selectUntouchedKeylessWorkflowCursor(
  identity: Required<Pick<WorkflowCursorSelector, 'project' | 'workflow' | 'mode'>>,
  ownerSession: string | null | undefined,
  d: Database,
): SelectableCursorRow | null {
  if (!ownerSession) return null
  const rows = d
    .query(
      `SELECT ${LISTED_CURSOR_COLUMNS} FROM workflow_cursor
       WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
         AND workflow_slug=? AND mode_slug=? AND workflow_key=''
         AND session_id=? AND state NOT IN ('done','abandoned')
         AND ordinal=0 ORDER BY number`,
    )
    .all(identity.project, identity.workflow, identity.mode, ownerSession)
    .filter(
      (row) => !hasClosedStep((row as SelectableCursorRow & { closed: string }).closed),
    ) as SelectableCursorRow[]
  if (rows.length > 1) refuseAmbiguousKeylessCursors(rows)
  return rows[0] ?? null
}

export function resolveWorkflowCursorMode(
  slug: string,
  project: string,
  requested: string | undefined,
  args: Record<string, string>,
  context: WorkflowCursorContext,
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
       WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
         AND workflow_slug=? AND task_record_id=?
         AND ${key ? "instance_id=''" : 'session_id=?'}
         AND state NOT IN ('done','abandoned') ORDER BY mode_slug`,
    )
    .all(
      ...(key
        ? [project, slug, context.taskRecordId ?? null]
        : [project, slug, key, context.session ?? '']),
    ) as {
    mode_slug: string
  }[]
  if (rows.length === 1) return rows[0]!.mode_slug
  if (rows.length > 1)
    throw new Error(
      `${caller} cannot resolve a mode for workflow "${slug}"; active cursor modes: ` +
        `${rows.map(({ mode_slug }) => mode_slug).join(', ')}; ${remedy}`,
    )
  const definition = showResolvedWorkflow(slug, undefined, project, d).definition
  const mode = resolveWorkflowMode(definition)
  if (mode) return mode.slug
  throw new Error(
    `${caller} cannot resolve a default mode for workflow "${slug}"; ` +
      `modes: ${definition.modes.map(({ slug: modeSlug }) => modeSlug).join(', ')}; ${remedy}`,
  )
}

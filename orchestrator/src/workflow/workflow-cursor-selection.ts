// concern: workflow cursor selection
/** Selects one open workflow cursor by public handle or declared identity. */
import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { db, sessionId } from '../database/db.ts'
import type { RecordTaskFlowClient } from '../record/record-api-client-task-flow.ts'
import { openTaskFlowStageCursor } from './task-flow.ts'
import {
  readThroughTaskFlow,
  type TaskFlowReadStatus,
  taskFlowReadThroughEnabled,
} from './task-flow-read-through.ts'
import { taskFlowStore } from './task-flow-store.ts'
import type { TaskFlowStageCursorRow } from './task-flow-store-types.ts'
import { workflowKeyOf } from './workflow-cursor-arguments.ts'
import { workflowTaskBindingCommand } from './workflow-cursor-format.ts'
import { hasClosedStep } from './workflow-cursor-trail.ts'
import { type HubTaskReader, resolveHubTaskReference } from './workflow-task-reference.ts'
import { resolveWorkflowMode, showResolvedWorkflow } from './workflows.ts'

export type WorkflowCursorSelector = {
  project?: string
  workflow?: string
  mode?: string
  key?: string
}

export type WorkflowCursorContext = {
  session?: string | null
  instance?: string
  workflowKey?: string
  taskRecordId?: string | null
  adoptionTaskRecordId?: string | null
  taskStatusCategory?: string | null
  taskFlowRead?: TaskFlowReadStatus
  taskFlowClient?: RecordTaskFlowClient
}

const MCP_INSTANCE = randomUUID()

export const mcpWorkflowCursorContext = (): WorkflowCursorContext => ({
  session: sessionId(),
  instance: MCP_INSTANCE,
})

export const cliWorkflowCursorContext = (): WorkflowCursorContext => ({ session: sessionId() })

/** Chooses the task key whose hosted flow must be read before cursor selection continues. */
function workflowCursorContextKey(
  argvKey: string | undefined,
  rowKey: string | undefined,
): string | undefined {
  if (argvKey) return argvKey
  return rowKey || undefined
}

export function findWorkflowCursor(
  project: string,
  workflow: string,
  mode: string,
  args: Record<string, string>,
  context: WorkflowCursorContext,
  database: Database,
  cursor?: number,
): SelectableCursorRow | null {
  const key = workflowKeyOf(args)
  return selectWorkflowCursor(
    { project, workflow, mode, ...(key ? { key } : {}) },
    cursor,
    context.session,
    database,
    context.taskRecordId,
    context.taskStatusCategory,
  )
}

export async function resolveWorkflowCursorContext(
  project: string,
  args: Record<string, string>,
  context: WorkflowCursorContext,
  reader?: HubTaskReader,
  selectedRow?: Pick<SelectableCursorRow, 'workflow_key'>,
): Promise<WorkflowCursorContext> {
  const key = workflowCursorContextKey(workflowKeyOf(args) || undefined, selectedRow?.workflow_key)
  if (!key) return { ...context, workflowKey: undefined, taskRecordId: null }
  const task = await resolveHubTaskReference(project, key, reader)
  return {
    ...context,
    workflowKey: key,
    taskRecordId: task?.record_id ?? null,
    taskStatusCategory: task?.status_category ?? null,
  }
}

/** Refreshes a resolved keyed context only after local-only refusals have been decided. */
export async function readThroughWorkflowCursorContext(
  project: string,
  context: WorkflowCursorContext,
  database: Database = db(),
): Promise<WorkflowCursorContext> {
  if (!context.workflowKey || !context.taskRecordId) return context
  if (!taskFlowReadThroughEnabled(database)) return context
  const taskFlowRead = await readThroughTaskFlow(database, {
    project,
    taskKey: context.workflowKey,
    taskRecordId: context.taskRecordId,
  })
  context.taskFlowRead = taskFlowRead
  return context
}

export const resolveMcpCursorContext = (
  project: string,
  args: Record<string, string>,
  reader?: HubTaskReader,
  selectedRow?: Pick<SelectableCursorRow, 'workflow_key'>,
) => resolveWorkflowCursorContext(project, args, mcpWorkflowCursorContext(), reader, selectedRow)

export async function resolveMcpSelectedCursorContext(
  project: string | undefined,
  workflow: string | undefined,
  _mode: string | undefined,
  args: Record<string, string>,
  cursor: number | undefined,
  reader?: HubTaskReader,
): Promise<{ context: WorkflowCursorContext; selectedRow?: SelectableCursorRow }> {
  const selectedRow =
    cursor === undefined
      ? undefined
      : selectWorkflowCursorByHandle({ project, workflow }, cursor, null, db())
  const resolvedProject = selectedRow?.project ?? project
  if (!resolvedProject) throw new Error('project is required without --cursor')
  return {
    context: await resolveMcpCursorContext(resolvedProject, args, reader, selectedRow),
    selectedRow,
  }
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

export type SelectableCursorRow = TaskFlowStageCursorRow

const mismatch = (
  row: Pick<SelectableCursorRow, 'id' | 'workflow_slug'>,
  name: string,
  supplied: string,
  stored: string,
): never => {
  throw new Error(
    `cursor ${row.id} ${name} mismatch: supplied "${supplied}", cursor has "${stored}"${name === 'key' && stored === 'unassigned' ? `; bind it with: ${workflowTaskBindingCommand(row)}` : ''}`,
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
    mismatch(row, 'project', identity.project, row.project)
  if (identity.workflow && identity.workflow !== row.workflow_slug)
    mismatch(row, 'workflow', identity.workflow, row.workflow_slug)
  if (identity.mode && identity.mode !== row.mode_slug)
    mismatch(row, 'mode', identity.mode, row.mode_slug)
  if (identity.key && identity.key !== row.workflow_key)
    mismatch(row, 'key', identity.key, row.workflow_key || 'unassigned')
  return row
}

function selectByHandle(
  cursor: number,
  identity: WorkflowCursorSelector,
  d: Database,
  includeTerminal = false,
): SelectableCursorRow {
  const row = taskFlowStore(d).stageByHandle(cursor)
  if (!row)
    throw new Error(
      `workflow cursor ${cursor} does not exist on this machine; cursor handles are per-machine labels, so pass the task key as the workflow argument key (--arg key=<KEY> on the CLI, args.key over MCP) to read the hosted flow`,
    )
  validateIdentity(row, identity)
  if (!includeTerminal && (row.state === 'done' || row.state === 'abandoned'))
    throw new Error(
      `cursor ${row.id} is ${row.state}; a new run is opened by fetching step 1 without a handle`,
    )
  return row
}

/** Selects a cursor handle using only the identity shared by CLI and MCP surfaces. */
export function selectWorkflowCursorByHandle(
  identity: Pick<WorkflowCursorSelector, 'project' | 'workflow'>,
  cursor: number,
  ownerSession: string | null | undefined,
  database: Database,
): SelectableCursorRow {
  return selectWorkflowCursor(identity, cursor, ownerSession, database)!
}

/** Selects the cursor a close targets while leaving terminal-state refusal to the close service. */
export function selectWorkflowCursorForClose(
  identity: WorkflowCursorSelector,
  cursor: number | undefined,
  ownerSession: string | null | undefined,
  d: Database,
  taskRecordId?: string | null,
  taskStatusCategory?: string | null,
): SelectableCursorRow | null {
  if (cursor !== undefined) return selectByHandle(cursor, identity, d, true)
  return selectWorkflowCursor(identity, cursor, ownerSession, d, taskRecordId, taskStatusCategory)
}

function selectKeyedTaskStage(
  identity: Required<WorkflowCursorSelector>,
  cursor: number | undefined,
  d: Database,
  taskRecordId: string | null | undefined,
  _taskStatusCategory: string | null | undefined,
): SelectableCursorRow | null {
  const handled = cursor === undefined ? null : selectByHandle(cursor, identity, d)
  if (!taskRecordId) return handled
  if (handled) return handled
  const row = openTaskFlowStageCursor(taskRecordId, d)
  if (row) {
    if (
      row.workflow_slug === identity.workflow &&
      row.mode_slug === identity.mode &&
      row.workflow_key === identity.key
    )
      return validateIdentity(row, identity)
  }
  const fallback = taskFlowStore(d).latestStageForTask({
    project: identity.project,
    workflow: identity.workflow,
    mode: identity.mode,
    taskRecordId,
  })
  return fallback ? validateIdentity(fallback, identity) : null
}

export function selectWorkflowCursor(
  identity: WorkflowCursorSelector,
  cursor: number | undefined,
  ownerSession: string | null | undefined,
  d: Database,
  taskRecordId?: string | null,
  taskStatusCategory?: string | null,
): SelectableCursorRow | null {
  if (identity.key && identity.project && identity.workflow && identity.mode)
    return selectKeyedTaskStage(
      identity as Required<WorkflowCursorSelector>,
      cursor,
      d,
      taskRecordId,
      taskStatusCategory,
    )
  if (cursor !== undefined) return selectByHandle(cursor, identity, d)
  if (!identity.project || !identity.workflow || !identity.mode) return null
  if (!ownerSession) return null
  const rows = taskFlowStore(d).openKeylessStages({
    project: identity.project,
    workflow: identity.workflow,
    mode: identity.mode,
    sessionId: ownerSession,
    untouched: false,
  })
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
  const rows = taskFlowStore(d)
    .openKeylessStages({
      project: identity.project,
      workflow: identity.workflow,
      mode: identity.mode,
      sessionId: ownerSession,
      untouched: true,
    })
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
  selectedRow?: SelectableCursorRow,
): string {
  const key = workflowKeyOf(args)
  const identity = {
    project,
    workflow: slug,
    ...(requested ? { mode: requested } : {}),
    key: key || undefined,
  }
  if (selectedRow) return validateIdentity(selectedRow, identity).mode_slug
  if (requested) return requested
  const rows = taskFlowStore(d).activeStageModes({
    project,
    workflow: slug,
    taskRecordId: context.taskRecordId ?? null,
    key,
    sessionId: context.session ?? '',
  })
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

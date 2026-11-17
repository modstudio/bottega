// concern: workflow cursor selection
/** Selects one open workflow cursor by public handle or declared identity. */
import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { recordApiConfigured } from '../../../shared/record-api-url.ts'
import { RECORD_SIGN_IN_REMEDY } from '../../../shared/record-remedies.ts'
import { db, sessionId } from '../database/db.ts'
import { RecordApiRequestError, recordApiClient } from '../record/record-api-client.ts'
import type { RecordTaskFlowClient } from '../record/record-api-client-task-flow.ts'
import { RECORD_TASK_FLOW_NOT_FOUND_MESSAGE } from '../record/record-task-flow-contract.ts'
import {
  resolveTaskFlowDestination,
  taskFlowWriteTarget,
} from '../record/record-task-flow-write-client.ts'
import {
  currentRecordWriteDecision,
  throwIfRecordRefused,
} from '../record/record-write-authority.ts'
import { decideTaskFlowReadStatus, type TaskFlowReadStatus } from './task-flow-decision.ts'
import { taskFlowReadStore } from './task-flow-store.ts'
import type { TaskFlowStageCursorRow } from './task-flow-store-types.ts'
import { workflowKeyOf } from './workflow-cursor-arguments.ts'
import { workflowCursorListCommand, workflowTaskBindingCommand } from './workflow-cursor-format.ts'
import { workflowCursorProject } from './workflow-cursor-project.ts'
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

export async function findWorkflowCursor(
  project: string,
  workflow: string,
  mode: string,
  args: Record<string, string>,
  context: WorkflowCursorContext,
  database: Database,
  cursor?: number,
): Promise<SelectableCursorRow | null> {
  const key = workflowKeyOf(args)
  return selectWorkflowCursor(
    { project, workflow, mode, ...(key ? { key } : {}) },
    cursor,
    context.session,
    database,
    context.taskRecordId,
    context.taskStatusCategory,
    context.taskFlowClient,
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
  const decision = currentRecordWriteDecision(database)
  throwIfRecordRefused(decision)
  if (decision.verdict !== 'hosted') return context
  const configured = recordApiConfigured(process.env)
  try {
    const client = context.taskFlowClient ?? recordApiClient()
    const destination = await resolveTaskFlowDestination(
      taskFlowWriteTarget(project, database),
      client,
    )
    const hosted = await client.readTaskFlow!({ taskKey: context.workflowKey }, destination)
    context.taskFlowRead = {
      status: 'reachable',
      ...(hosted.stage ? { holder: hosted.stage.holder } : {}),
    }
  } catch (error) {
    if (!(error instanceof RecordApiRequestError)) throw error
    context.taskFlowRead = decideTaskFlowReadStatus({
      status: error.status,
      recognizedNotFound:
        error.status === 404 && error.message === RECORD_TASK_FLOW_NOT_FOUND_MESSAGE,
      configured,
      errorRemedy: configured
        ? error.message
        : `hosted record is not configured; ${RECORD_SIGN_IN_REMEDY}`,
    })
  }
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
      : await selectWorkflowCursorByHandle({ project, workflow }, cursor, null, db())
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

/** Requires an explicit owner-session acknowledgement before a public abandon crosses sessions. */
export function refuseForeignCursorAbandon(
  row: Pick<SelectableCursorRow, 'id' | 'session_id'>,
  callerSession: string | null | undefined,
  ownerSession: string | undefined,
  surface: 'cli' | 'mcp',
): void {
  if (!row.session_id || row.session_id === callerSession || ownerSession === row.session_id) return
  const remedy =
    surface === 'cli'
      ? `rerun with --owner-session ${row.session_id}`
      : `retry with owner_session ${JSON.stringify(row.session_id)}`
  throw new Error(
    `workflow cursor ${row.id} is owned by session ${row.session_id}; ${remedy} to state intent to abandon it`,
  )
}

const mismatch = (
  row: Pick<SelectableCursorRow, 'id' | 'workflow_slug' | 'project'>,
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

export async function selectByHandle(
  cursor: number,
  identity: WorkflowCursorSelector,
  d: Database,
  includeTerminal = false,
  client?: RecordTaskFlowClient,
): Promise<SelectableCursorRow> {
  const project = workflowCursorProject(identity.project, process.cwd(), d)
  const row = await taskFlowReadStore(d, client).stageByHandle(project, cursor)
  if (!row)
    throw new Error(
      `workflow cursor ${cursor} does not exist in project ${project}; cursor handles changed to per-project numbers, so list cursors again with ${workflowCursorListCommand}; a local handle need not exist in the hosted flow, so pass the task key as the workflow argument key (--arg key=<KEY> on the CLI, args.key over MCP) to read it`,
    )
  validateIdentity(row, identity)
  if (!includeTerminal && (row.state === 'done' || row.state === 'abandoned'))
    throw new Error(
      `cursor ${row.id} is ${row.state}; a new run is opened by fetching step 1 without a handle`,
    )
  return row
}

/** Selects a cursor handle using only the identity shared by CLI and MCP surfaces. */
export async function selectWorkflowCursorByHandle(
  identity: Pick<WorkflowCursorSelector, 'project' | 'workflow'>,
  cursor: number,
  ownerSession: string | null | undefined,
  database: Database,
  client?: RecordTaskFlowClient,
): Promise<SelectableCursorRow> {
  return (await selectWorkflowCursor(
    identity,
    cursor,
    ownerSession,
    database,
    undefined,
    undefined,
    client,
  ))!
}

/** Selects the cursor a close targets while leaving terminal-state refusal to the close service. */
export async function selectWorkflowCursorForClose(
  identity: WorkflowCursorSelector,
  cursor: number | undefined,
  ownerSession: string | null | undefined,
  d: Database,
  taskRecordId?: string | null,
  taskStatusCategory?: string | null,
  client?: RecordTaskFlowClient,
): Promise<SelectableCursorRow | null> {
  if (cursor !== undefined) return selectByHandle(cursor, identity, d, true, client)
  return selectWorkflowCursor(
    identity,
    cursor,
    ownerSession,
    d,
    taskRecordId,
    taskStatusCategory,
    client,
  )
}

async function selectKeyedTaskStage(
  identity: Required<WorkflowCursorSelector>,
  cursor: number | undefined,
  d: Database,
  taskRecordId: string | null | undefined,
  _taskStatusCategory: string | null | undefined,
  client?: RecordTaskFlowClient,
): Promise<SelectableCursorRow | null> {
  const handled =
    cursor === undefined ? null : await selectByHandle(cursor, identity, d, false, client)
  if (!taskRecordId) return handled
  if (handled) return handled
  const row = await taskFlowReadStore(d, client).openStageForTask(taskRecordId)
  if (row) {
    if (
      row.workflow_slug === identity.workflow &&
      row.mode_slug === identity.mode &&
      row.workflow_key === identity.key
    )
      return validateIdentity(row, identity)
  }
  const fallback = await taskFlowReadStore(d, client).latestStageForTask({
    project: identity.project,
    workflow: identity.workflow,
    mode: identity.mode,
    taskRecordId,
  })
  return fallback ? validateIdentity(fallback, identity) : null
}

export async function selectWorkflowCursor(
  identity: WorkflowCursorSelector,
  cursor: number | undefined,
  ownerSession: string | null | undefined,
  d: Database,
  taskRecordId?: string | null,
  taskStatusCategory?: string | null,
  client?: RecordTaskFlowClient,
): Promise<SelectableCursorRow | null> {
  if (identity.key && identity.project && identity.workflow && identity.mode)
    return selectKeyedTaskStage(
      identity as Required<WorkflowCursorSelector>,
      cursor,
      d,
      taskRecordId,
      taskStatusCategory,
      client,
    )
  if (cursor !== undefined) return selectByHandle(cursor, identity, d, false, client)
  if (!identity.project || !identity.workflow || !identity.mode) return null
  if (!ownerSession) return null
  const rows = await taskFlowReadStore(d, client).openKeylessStages({
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

export async function selectUntouchedKeylessWorkflowCursor(
  identity: Required<Pick<WorkflowCursorSelector, 'project' | 'workflow' | 'mode'>>,
  ownerSession: string | null | undefined,
  d: Database,
  client?: RecordTaskFlowClient,
): Promise<SelectableCursorRow | null> {
  if (!ownerSession) return null
  const rows = (
    await taskFlowReadStore(d, client).openKeylessStages({
      project: identity.project,
      workflow: identity.workflow,
      mode: identity.mode,
      sessionId: ownerSession,
      untouched: true,
    })
  ).filter(
    (row) => !hasClosedStep((row as SelectableCursorRow & { closed: string }).closed),
  ) as SelectableCursorRow[]
  if (rows.length > 1) refuseAmbiguousKeylessCursors(rows)
  return rows[0] ?? null
}

export async function resolveWorkflowCursorMode(
  slug: string,
  project: string,
  requested: string | undefined,
  args: Record<string, string>,
  context: WorkflowCursorContext,
  caller: string,
  remedy: string,
  d: Database = db(),
  selectedRow?: SelectableCursorRow,
): Promise<string> {
  const key = workflowKeyOf(args)
  const identity = {
    project,
    workflow: slug,
    ...(requested ? { mode: requested } : {}),
    key: key || undefined,
  }
  if (selectedRow) return validateIdentity(selectedRow, identity).mode_slug
  if (requested) return requested
  const rows = await taskFlowReadStore(d, context.taskFlowClient).activeStageModes({
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

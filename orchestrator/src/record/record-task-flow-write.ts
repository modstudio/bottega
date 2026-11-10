// concern: hosted task-flow writes
/** Applies tenant-bound workflow command intents with optimistic revisions and request idempotency. */
import type { SQL } from 'bun'
import { newRecordId } from '../../../shared/record-id.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { DocRevisionConflictError } from '../doc/doc-revision-conflict.ts'
import { recordPool } from './record-pool.ts'
import type {
  TaskFlowIntent,
  TaskFlowIntentInput,
  TaskFlowWriteResult,
} from './record-task-flow-write-contract.ts'

type Tenant = { url: string } & TenantPrincipal
type Mutation = { id: string; expectedRevision: number; values: Record<string, unknown> }
type RevisionRow = { revision: number | string; last_request_id: string | null }

const columnNames: Record<string, string> = {
  flowRecordId: 'flow_record_id',
  workflowKey: 'workflow_key',
  instanceId: 'instance_id',
  sessionId: 'session_id',
  activeOrdinal: 'active_ordinal',
  activeSlug: 'active_slug',
  closedStepNotes: 'closed_step_notes',
  takenOverFromMachineId: 'taken_over_from_machine_id',
  lastAdvancedMachineId: 'last_advanced_machine_id',
  openStageRecordId: 'open_stage_record_id',
  openingMachineId: 'opening_machine_id',
  updatedMachineId: 'updated_machine_id',
  updatedAt: 'updated_at',
}
const jsonColumns = new Set(['arguments', 'closed_step_notes'])

function conflict(table: string, id: string, currentRevision: number | null, reason = 'stale-revision') {
  throw new DocRevisionConflictError(
    `${table} ${id} does not satisfy the requested write precondition`,
    `${table}.id=${id}`,
    reason as 'stale-revision' | 'already-exists',
    currentRevision == null ? null : String(currentRevision),
  )
}

async function revisionDecision(
  tx: SQL,
  table: 'task_flow' | 'task_flow_stage',
  mutation: Mutation,
  requestId: string,
): Promise<'write' | 'retry'> {
  const rows = (await tx.unsafe(
    `SELECT revision,last_request_id::text FROM ${table} WHERE id=$1::uuid FOR UPDATE`,
    [mutation.id],
  )) as RevisionRow[]
  const row = rows[0]
  if (!row) conflict(table, mutation.id, null)
  const current = Number(row!.revision)
  if (current === mutation.expectedRevision) return 'write'
  if (current === mutation.expectedRevision + 1 && row!.last_request_id === requestId) return 'retry'
  return conflict(table, mutation.id, current)
}

async function updateRevisionRow(
  tx: SQL,
  table: 'task_flow' | 'task_flow_stage',
  mutation: Mutation,
  requestId: string,
): Promise<number> {
  if ((await revisionDecision(tx, table, mutation, requestId)) === 'retry')
    return mutation.expectedRevision + 1
  const entries = Object.entries(mutation.values)
  const assignments = entries.map(([key], index) => {
    const column = columnNames[key] ?? key
    return `${column}=$${index + 1}${jsonColumns.has(column) ? '::jsonb' : ''}`
  })
  const parameters = entries.map(([key, value]) => {
    const column = columnNames[key] ?? key
    return jsonColumns.has(column) ? JSON.stringify(value) : value
  })
  parameters.push(requestId, mutation.id, mutation.expectedRevision)
  const request = entries.length + 1
  const id = entries.length + 2
  const expected = entries.length + 3
  const rows = (await tx.unsafe(
    `UPDATE ${table} SET ${assignments.join(',')},revision=$${expected}+1,last_request_id=$${request}::uuid
     WHERE id=$${id}::uuid AND revision=$${expected} RETURNING revision`,
    parameters,
  )) as Array<{ revision: number | string }>
  if (!rows[0]) conflict(table, mutation.id, null)
  return Number(rows[0]!.revision)
}

const comparable = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(comparable)
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, comparable(item)]))
  return value
}
const same = (left: unknown, right: unknown) =>
  JSON.stringify(comparable(left)) === JSON.stringify(comparable(right))

async function existingRow(tx: SQL, table: string, id: string) {
  return ((await tx.unsafe(`SELECT * FROM ${table} WHERE id=$1::uuid FOR UPDATE`, [id])) as Array<
    Record<string, unknown>
  >)[0]
}

function assertSameInsert(
  table: string,
  id: string,
  existing: Record<string, unknown>,
  values: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(values)) {
    const column = columnNames[key] ?? key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
    if (!same(existing[column], value)) conflict(table, id, null, 'already-exists')
  }
}

async function insertFlow(
  tx: SQL,
  spaceId: string,
  requestId: string,
  row: Record<string, unknown>,
): Promise<number> {
  const existing = await existingRow(tx, 'task_flow', String(row.id))
  if (existing) {
    assertSameInsert('task_flow', String(row.id), existing, row)
    return Number(existing.revision)
  }
  await tx`INSERT INTO task_flow
    (id,space_id,project_id,task_id,state,open_stage_record_id,opening_machine_id,updated_machine_id,
     revision,last_request_id,created_at,updated_at)
    VALUES (${row.id}::uuid,${spaceId}::uuid,${row.projectId}::uuid,${row.taskId}::uuid,${row.state},
      ${row.openStageRecordId}::uuid,${row.openingMachineId}::uuid,${row.updatedMachineId}::uuid,
      1,${requestId}::uuid,${row.createdAt}::timestamptz,${row.updatedAt}::timestamptz)`
  return 1
}

async function allocateStageNumber(tx: SQL, spaceId: string, projectId: string): Promise<number> {
  const name = 'task_flow_stage'
  await tx`INSERT INTO seq(id,space_id,project_id,name,next)
    VALUES (${newRecordId()}::uuid,${spaceId}::uuid,${projectId}::uuid,${name},1)
    ON CONFLICT(space_id,project_id,name) DO NOTHING`
  const rows = (await tx`SELECT next::text FROM seq WHERE space_id=${spaceId}::uuid
    AND project_id=${projectId}::uuid AND name=${name} FOR UPDATE`) as Array<{ next: string }>
  const number = Number(rows[0]!.next)
  await tx`UPDATE seq SET next=${number + 1} WHERE space_id=${spaceId}::uuid
    AND project_id=${projectId}::uuid AND name=${name}`
  return number
}

async function insertStage(
  tx: SQL,
  spaceId: string,
  requestId: string,
  row: Record<string, unknown>,
): Promise<number> {
  const existing = await existingRow(tx, 'task_flow_stage', String(row.id))
  if (existing) {
    assertSameInsert('task_flow_stage', String(row.id), existing, row)
    return Number(existing.revision)
  }
  const flow = (await tx`SELECT project_id::text FROM task_flow WHERE id=${row.flowRecordId}::uuid FOR UPDATE`) as Array<{
    project_id: string
  }>
  if (!flow[0] || flow[0].project_id !== row.projectId)
    conflict('task_flow_stage', String(row.id), null, 'already-exists')
  const number = await allocateStageNumber(tx, spaceId, String(row.projectId))
  await tx`INSERT INTO task_flow_stage
    (id,space_id,flow_record_id,project_id,number,workflow,mode,workflow_key,instance_id,session_id,
     workflow_version_id,catalogue_version_id,arguments,active_ordinal,active_slug,state,closed_step_notes,
     question,autonomy,enforcement,total_steps,opened_machine_id,taken_over_from_machine_id,
     last_advanced_machine_id,revision,last_request_id,created_at,updated_at)
    VALUES (${row.id}::uuid,${spaceId}::uuid,${row.flowRecordId}::uuid,${row.projectId}::uuid,${number},
      ${row.workflow},${row.mode},${row.workflowKey},${row.instanceId},${row.sessionId},
      ${row.workflowVersionId}::uuid,${row.catalogueVersionId}::uuid,${JSON.stringify(row.arguments)}::jsonb,
      ${row.activeOrdinal},${row.activeSlug},${row.state},${JSON.stringify(row.closedStepNotes)}::jsonb,
      ${row.question},${row.autonomy},${row.enforcement},${row.totalSteps},${row.openedMachineId}::uuid,
      ${row.takenOverFromMachineId}::uuid,${row.lastAdvancedMachineId}::uuid,1,${requestId}::uuid,
      ${row.createdAt}::timestamptz,${row.updatedAt}::timestamptz)`
  return 1
}

async function insertObligation(tx: SQL, spaceId: string, row: Record<string, unknown>) {
  const existing = await existingRow(tx, 'workflow_obligation', String(row.id))
  if (existing) return assertSameInsert('workflow_obligation', String(row.id), existing, row)
  await tx`INSERT INTO workflow_obligation
    (id,space_id,stage_record_id,step_ordinal,step_slug,floor,require_pull_request,expected_exit_code,
     expected_status,floor_deferrable,reason,session_id,created_at,satisfied_at,satisfied_step_ordinal,
     satisfied_step_slug,satisfied_evidence,abandoned_at,abandoned_reason,operator_ruling)
    VALUES (${row.id}::uuid,${spaceId}::uuid,${row.stageRecordId}::uuid,${row.stepOrdinal},${row.stepSlug},
      ${row.floor},${row.requirePullRequest},${row.expectedExitCode},${row.expectedStatus},${row.floorDeferrable},
      ${row.reason},${row.sessionId},${row.createdAt}::timestamptz,${row.satisfiedAt}::timestamptz,
      ${row.satisfiedStepOrdinal},${row.satisfiedStepSlug},${JSON.stringify(row.satisfiedEvidence)}::jsonb,
      ${row.abandonedAt}::timestamptz,${row.abandonedReason},${row.operatorRuling})`
}

async function updateObligation(tx: SQL, row: Record<string, unknown>) {
  const entries = Object.entries(row).filter(([key]) => key !== 'id' && key !== 'stageRecordId')
  const sets = entries.map(([key], index) => {
    const column = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
    return `${column}=$${index + 1}${column === 'satisfied_evidence' ? '::jsonb' : ''}`
  })
  const values = entries.map(([key, value]) =>
    key === 'satisfiedEvidence' ? JSON.stringify(value) : value,
  )
  await tx.unsafe(
    `UPDATE workflow_obligation SET ${sets.join(',')} WHERE id=$${values.length + 1}::uuid AND stage_record_id=$${values.length + 2}::uuid`,
    [...values, row.id, row.stageRecordId],
  )
}

async function insertText(tx: SQL, spaceId: string, row: Record<string, unknown>) {
  const existing = await existingRow(tx, 'workflow_step_text', String(row.id))
  if (existing) return assertSameInsert('workflow_step_text', String(row.id), existing, row)
  await tx`INSERT INTO workflow_step_text(id,space_id,stage_record_id,step_ordinal,step_slug,body,created_at)
    VALUES (${row.id}::uuid,${spaceId}::uuid,${row.stageRecordId}::uuid,${row.stepOrdinal},${row.stepSlug},
      ${row.body},${row.createdAt}::timestamptz)`
}

async function insertCopy(tx: SQL, spaceId: string, row: Record<string, unknown>) {
  const existing = await existingRow(tx, 'workflow_text_copy', String(row.id))
  if (existing) return assertSameInsert('workflow_text_copy', String(row.id), existing, row)
  await tx`INSERT INTO workflow_text_copy
    (id,space_id,workflow_text_record_id,stage_record_id,task_document_reference,copied_at)
    VALUES (${row.id}::uuid,${spaceId}::uuid,${row.workflowTextRecordId}::uuid,${row.stageRecordId}::uuid,
      ${row.taskDocumentReference},${row.copiedAt}::timestamptz)`
}

async function applyIntent<K extends TaskFlowIntent>(
  tx: SQL,
  input: Tenant & TaskFlowIntentInput<K>,
  intent: K,
): Promise<TaskFlowWriteResult> {
  const revisions: Record<string, number> = {}
  const body = input as Tenant & Record<string, any>
  if (intent === 'compose') {
    if (body.flowInsert)
      revisions[body.flowInsert.id] = await insertFlow(tx, input.spaceId, body.requestId, body.flowInsert)
    if (body.flowChange)
      revisions[body.flowChange.id] = await updateRevisionRow(tx, 'task_flow', body.flowChange, body.requestId)
    if (body.stageInsert)
      revisions[body.stageInsert.id] = await insertStage(tx, input.spaceId, body.requestId, body.stageInsert)
    for (const change of body.stageChanges)
      revisions[change.id] = await updateRevisionRow(tx, 'task_flow_stage', change, body.requestId)
  } else if (intent === 'stage-update' || intent === 'advance' || intent === 'await-ruling' || intent === 'abandon') {
    revisions[body.stage.id] = await updateRevisionRow(tx, 'task_flow_stage', body.stage, body.requestId)
    if (body.flow)
      revisions[body.flow.id] = await updateRevisionRow(tx, 'task_flow', body.flow, body.requestId)
    for (const row of body.obligationInserts ?? []) await insertObligation(tx, input.spaceId, row)
    for (const row of body.obligationUpdates ?? []) await updateObligation(tx, row)
  } else if (intent === 'attach-text') {
    for (const row of body.rows) await insertText(tx, input.spaceId, row)
  } else if (intent === 'delete-text') {
    await tx`DELETE FROM workflow_step_text WHERE id IN ${tx(body.ids)} AND space_id=${input.spaceId}::uuid`
  } else if (intent === 'copy-text') await insertCopy(tx, input.spaceId, body.row)
  return { revisions }
}

function writeIntent<K extends TaskFlowIntent>(intent: K) {
  return async (input: Tenant & TaskFlowIntentInput<K>): Promise<TaskFlowWriteResult> =>
    recordPool(input.url).begin(async (tx) => {
      await bindTenant(tx, input)
      return applyIntent(tx, input, intent)
    })
}

export const composeRecordTaskFlow = writeIntent('compose')
export const updateRecordTaskFlowStage = writeIntent('stage-update')
export const advanceRecordTaskFlow = writeIntent('advance')
export const awaitRecordTaskFlowRuling = writeIntent('await-ruling')
export const abandonRecordTaskFlow = writeIntent('abandon')
export const attachRecordTaskFlowText = writeIntent('attach-text')
export const deleteRecordTaskFlowText = writeIntent('delete-text')
export const copyRecordTaskFlowText = writeIntent('copy-text')

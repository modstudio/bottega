// concern: hosted task-flow writes
/** Applies tenant-bound workflow command intents with optimistic revisions and request idempotency.
 * Every intent locks task_flow first, task_flow_stage second, and child rows last.
 */
import type { SQL } from 'bun'
import { bindJsonb } from '../../../shared/record/jsonb-sql.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { DocRevisionConflictError } from '../doc/doc-revision-conflict.ts'
import { isUniqueViolation } from './record-config-error.ts'
import { recordPool } from './record-pool.ts'
import { allocateRecordSequence } from './record-sequence.ts'
import type {
  TaskFlowIntent,
  TaskFlowIntentBody,
  TaskFlowWriteResult,
} from './record-task-flow-write-contract.ts'
import {
  decideRevisionPreflight,
  decideRevisionWrite,
  sameRecordValue,
} from './record-task-flow-write-decision.ts'

type Tenant = { url: string } & TenantPrincipal
type Mutation = { id: string; expectedRevision: number; values: Record<string, unknown> }
type RevisionRow = { revision: number | string; last_request_id: string | null }
type ComposeBody = TaskFlowIntentBody<'compose'>
type StageUpdateBody = TaskFlowIntentBody<'stage-update'>
type StageMutationBody =
  | TaskFlowIntentBody<'advance'>
  | TaskFlowIntentBody<'await-ruling'>
  | TaskFlowIntentBody<'abandon'>

const jsonColumns = new Set(['arguments', 'closed_step_notes', 'satisfied_evidence'])
const camelToSnake = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
const isJsonColumn = (column: string) => jsonColumns.has(column)

function conflict(
  table: string,
  id: string,
  currentRevision: number | null,
  reason: 'stale-revision' | 'already-exists' = 'stale-revision',
): never {
  return refusal(
    `${table} ${id} does not satisfy the requested write precondition`,
    `${table}.id=${id}`,
    reason,
    currentRevision == null ? null : String(currentRevision),
  )
}

function refusal(
  message: string,
  condition: string,
  reason: 'stale-revision' | 'already-exists',
  currentRevision: string | null = null,
): never {
  throw new DocRevisionConflictError(message, condition, reason, currentRevision)
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
  const decision = decideRevisionWrite(
    row ? { revision: Number(row.revision), lastRequestId: row.last_request_id } : null,
    mutation.expectedRevision,
    requestId,
  )
  if (decision.kind === 'conflict') return conflict(table, mutation.id, decision.currentRevision)
  return decision.kind
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
    const column = camelToSnake(key)
    return `${column}=$${index + 1}${isJsonColumn(column) ? '::jsonb' : ''}`
  })
  const parameters = entries.map(([key, value]) => {
    const column = camelToSnake(key)
    return isJsonColumn(column) ? JSON.stringify(value) : value
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

async function preflightMutations(
  tx: SQL,
  mutations: Array<{ table: 'task_flow' | 'task_flow_stage'; mutation: Mutation }>,
  requestId: string,
): Promise<'write' | 'retry'> {
  const decisions: Array<{
    table: 'task_flow' | 'task_flow_stage'
    mutation: Mutation
    decision: 'write' | 'retry'
  }> = []
  for (const { table, mutation } of mutations)
    decisions.push({
      table,
      mutation,
      decision: await revisionDecision(tx, table, mutation, requestId),
    })
  const preflight = decideRevisionPreflight(decisions.map(({ decision }) => decision))
  if (preflight.kind === 'retry') return 'retry'
  if (preflight.kind === 'partial-retry') {
    const partialRetry = decisions[preflight.index]!
    conflict(
      partialRetry.table,
      partialRetry.mutation.id,
      partialRetry.mutation.expectedRevision + 1,
    )
  }
  return 'write'
}

async function existingRow(tx: SQL, table: string, id: string) {
  return (
    (await tx.unsafe(`SELECT * FROM ${table} WHERE id=$1::uuid FOR UPDATE`, [id])) as Array<
      Record<string, unknown>
    >
  )[0]
}

function assertSameInsert(
  table: string,
  id: string,
  existing: Record<string, unknown>,
  values: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(values)) {
    const column = camelToSnake(key)
    if (!sameRecordValue(existing[column], value)) conflict(table, id, null, 'already-exists')
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

async function insertStage(
  tx: SQL,
  spaceId: string,
  requestId: string,
  row: Record<string, unknown>,
): Promise<number> {
  const flow =
    (await tx`SELECT project_id::text FROM task_flow WHERE id=${row.flowRecordId}::uuid FOR UPDATE`) as Array<{
      project_id: string
    }>
  if (!flow[0])
    refusal('parent flow not found', `task_flow.id=${String(row.flowRecordId)}`, 'stale-revision')
  if (flow[0].project_id !== row.projectId)
    refusal(
      `parent flow project ${flow[0].project_id} does not match stage project ${String(row.projectId)}`,
      `task_flow.id=${String(row.flowRecordId)}`,
      'stale-revision',
    )
  const existing = await existingRow(tx, 'task_flow_stage', String(row.id))
  if (existing) {
    assertSameInsert('task_flow_stage', String(row.id), existing, row)
    return Number(existing.revision)
  }
  const number = await allocateRecordSequence(tx, spaceId, String(row.projectId), 'task_flow_stage')
  await tx`INSERT INTO task_flow_stage
    (id,space_id,flow_record_id,project_id,number,workflow,mode,workflow_key,instance_id,session_id,
     workflow_version_id,catalogue_version_id,arguments,active_ordinal,active_slug,state,closed_step_notes,
     question,autonomy,enforcement,total_steps,opened_machine_id,taken_over_from_machine_id,
     last_advanced_machine_id,revision,last_request_id,created_at,updated_at)
    VALUES (${row.id}::uuid,${spaceId}::uuid,${row.flowRecordId}::uuid,${row.projectId}::uuid,${number},
      ${row.workflow},${row.mode},${row.workflowKey},${row.instanceId},${row.sessionId},
      ${row.workflowVersionId}::uuid,${row.catalogueVersionId}::uuid,${bindJsonb(tx, row.arguments)},
      ${row.activeOrdinal},${row.activeSlug},${row.state},${bindJsonb(tx, row.closedStepNotes)},
      ${row.question},${row.autonomy},${row.enforcement},${row.totalSteps},${row.openedMachineId}::uuid,
      ${row.takenOverFromMachineId}::uuid,${row.lastAdvancedMachineId}::uuid,1,${requestId}::uuid,
      ${row.createdAt}::timestamptz,${row.updatedAt}::timestamptz)`
  return 1
}

async function insertObligation(tx: SQL, spaceId: string, row: Record<string, unknown>) {
  const existing = await existingRow(tx, 'workflow_obligation', String(row.id))
  if (existing) return assertSameInsert('workflow_obligation', String(row.id), existing, row)
  const satisfiedEvidence =
    row.satisfiedEvidence === null ? null : bindJsonb(tx, row.satisfiedEvidence)
  await tx`INSERT INTO workflow_obligation
    (id,space_id,stage_record_id,step_ordinal,step_slug,floor,require_pull_request,expected_exit_code,
     expected_status,floor_deferrable,reason,session_id,created_at,satisfied_at,satisfied_step_ordinal,
     satisfied_step_slug,satisfied_evidence,abandoned_at,abandoned_reason,operator_ruling)
    VALUES (${row.id}::uuid,${spaceId}::uuid,${row.stageRecordId}::uuid,${row.stepOrdinal},${row.stepSlug},
      ${row.floor},${row.requirePullRequest},${row.expectedExitCode},${row.expectedStatus},${row.floorDeferrable},
      ${row.reason},${row.sessionId},${row.createdAt}::timestamptz,${row.satisfiedAt}::timestamptz,
      ${row.satisfiedStepOrdinal},${row.satisfiedStepSlug},${satisfiedEvidence},
      ${row.abandonedAt}::timestamptz,${row.abandonedReason},${row.operatorRuling})`
}

async function updateObligation(tx: SQL, row: Record<string, unknown>) {
  const entries = Object.entries(row).filter(([key]) => key !== 'id' && key !== 'stageRecordId')
  const sets = entries.map(([key], index) => {
    const column = camelToSnake(key)
    return `${column}=$${index + 1}${isJsonColumn(column) ? '::jsonb' : ''}`
  })
  const values = entries.map(([key, value]) =>
    isJsonColumn(camelToSnake(key)) ? JSON.stringify(value) : value,
  )
  const rows = (await tx.unsafe(
    `UPDATE workflow_obligation SET ${sets.join(',')} WHERE id=$${values.length + 1}::uuid AND stage_record_id=$${values.length + 2}::uuid RETURNING id::text`,
    [...values, row.id, row.stageRecordId],
  )) as Array<{ id: string }>
  if (rows.length !== 1) conflict('workflow_obligation', String(row.id), null)
}

async function deleteTexts(
  tx: SQL,
  spaceId: string,
  stageRecordId: string,
  ids: string[],
): Promise<void> {
  if (!ids.length) return
  const rows = (await tx`DELETE FROM workflow_step_text
    WHERE id IN ${tx(ids)} AND space_id=${spaceId}::uuid AND stage_record_id=${stageRecordId}::uuid
    RETURNING id::text`) as Array<{ id: string }>
  const returned = new Set(rows.map(({ id }) => id))
  const missing = ids.filter((id) => !returned.has(id))
  if (!missing.length) return
  const mismatched = (await tx`SELECT id::text FROM workflow_step_text
    WHERE id IN ${tx(missing)} AND space_id=${spaceId}::uuid FOR UPDATE`) as Array<{ id: string }>
  if (mismatched[0]) conflict('workflow_step_text', mismatched[0].id, null)
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
      ${row.taskDocumentReference},${row.copiedAt}::timestamptz)
    ON CONFLICT (workflow_text_record_id) DO NOTHING`
}

function postgresErrorChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    chain.push(current)
    current = 'cause' in current ? current.cause : null
  }
  return chain
}

function postgresConstraint(error: unknown): string | null {
  for (const item of postgresErrorChain(error)) {
    const candidate = item as { constraint?: unknown; constraint_name?: unknown }
    for (const value of [candidate.constraint, candidate.constraint_name])
      if (typeof value === 'string' && value) return value
  }
  return null
}

function postgresBlockedRow(error: unknown): string {
  for (const item of postgresErrorChain(error)) {
    const candidate = item as { detail?: unknown }
    if (typeof candidate.detail === 'string' && candidate.detail) return candidate.detail
  }
  return error instanceof Error ? error.message : String(error)
}

function postgresSqlState(error: unknown): string | null {
  for (const item of postgresErrorChain(error)) {
    const candidate = item as { code?: unknown; errno?: unknown }
    for (const value of [candidate.errno, candidate.code]) {
      if (typeof value !== 'string' && typeof value !== 'number') continue
      const normalized = String(value).toUpperCase()
      if (/^[0-9A-Z]{5}$/.test(normalized)) return normalized
    }
  }
  return null
}

async function applyCompose(tx: SQL, input: Tenant, body: ComposeBody) {
  const revisions: Record<string, number> = {}
  if (body.flowInsert)
    revisions[String(body.flowInsert.id)] = await insertFlow(
      tx,
      input.spaceId,
      body.requestId,
      body.flowInsert,
    )
  if (body.flowChange)
    revisions[body.flowChange.id] = await updateRevisionRow(
      tx,
      'task_flow',
      body.flowChange,
      body.requestId,
    )
  if (body.stageInsert)
    revisions[String(body.stageInsert.id)] = await insertStage(
      tx,
      input.spaceId,
      body.requestId,
      body.stageInsert,
    )
  for (const change of body.stageChanges ?? [])
    revisions[change.id] = await updateRevisionRow(tx, 'task_flow_stage', change, body.requestId)
  return { revisions }
}

async function lockParentFlowForStage(tx: SQL, stageId: string): Promise<void> {
  const rows = (await tx.unsafe(
    `SELECT flow.id::text FROM task_flow flow
     JOIN task_flow_stage stage ON stage.flow_record_id=flow.id
     WHERE stage.id=$1::uuid FOR UPDATE OF flow`,
    [stageId],
  )) as Array<{ id: string }>
  if (!rows[0]) conflict('task_flow_stage', stageId, null)
}

function assertStageChild(stageId: string, row: { id: string; stageRecordId: string }): void {
  if (row.stageRecordId !== stageId) conflict('workflow_obligation', row.id, null)
}

async function applyStageMutation(tx: SQL, input: Tenant, body: StageMutationBody) {
  const revisions: Record<string, number> = {}
  const stage = body.stage
  const flow = 'flow' in body ? body.flow : undefined
  if (!flow) await lockParentFlowForStage(tx, stage.id)
  const mutations = [
    ...(flow ? [{ table: 'task_flow' as const, mutation: flow }] : []),
    { table: 'task_flow_stage' as const, mutation: stage },
  ]
  if ((await preflightMutations(tx, mutations, body.requestId)) === 'retry') {
    for (const { mutation } of mutations) revisions[mutation.id] = mutation.expectedRevision + 1
    return { revisions }
  }
  if (flow) revisions[flow.id] = await updateRevisionRow(tx, 'task_flow', flow, body.requestId)
  revisions[stage.id] = await updateRevisionRow(tx, 'task_flow_stage', stage, body.requestId)
  if ('obligationInserts' in body)
    for (const row of body.obligationInserts ?? []) {
      assertStageChild(stage.id, row)
      await insertObligation(tx, input.spaceId, row)
    }
  if ('obligationUpdates' in body)
    for (const row of body.obligationUpdates ?? []) {
      assertStageChild(stage.id, row)
      await updateObligation(tx, row)
    }
  if ('deleteTextIds' in body)
    await deleteTexts(tx, input.spaceId, stage.id, body.deleteTextIds ?? [])
  return { revisions }
}

async function applyStageUpdates(tx: SQL, body: StageUpdateBody) {
  const revisions: Record<string, number> = {}
  if (!body.flow) for (const stage of body.stages) await lockParentFlowForStage(tx, stage.id)
  const mutations = [
    ...(body.flow ? [{ table: 'task_flow' as const, mutation: body.flow }] : []),
    ...body.stages.map((mutation) => ({ table: 'task_flow_stage' as const, mutation })),
  ]
  if ((await preflightMutations(tx, mutations, body.requestId)) === 'retry') {
    for (const { mutation } of mutations) revisions[mutation.id] = mutation.expectedRevision + 1
    return { revisions }
  }
  if (body.flow)
    revisions[body.flow.id] = await updateRevisionRow(tx, 'task_flow', body.flow, body.requestId)
  for (const stage of body.stages)
    revisions[stage.id] = await updateRevisionRow(tx, 'task_flow_stage', stage, body.requestId)
  return { revisions }
}

type Applier<K extends TaskFlowIntent> = (
  tx: SQL,
  input: Tenant & TaskFlowIntentBody<K>,
) => Promise<TaskFlowWriteResult>

const intentAppliers: { [K in TaskFlowIntent]: Applier<K> } = {
  compose: (tx, input) => applyCompose(tx, input, input),
  'stage-update': (tx, input) => applyStageUpdates(tx, input),
  advance: (tx, input) => applyStageMutation(tx, input, input),
  'await-ruling': (tx, input) => applyStageMutation(tx, input, input),
  abandon: (tx, input) => applyStageMutation(tx, input, input),
  'attach-text': async (tx, input) => {
    for (const row of input.rows) {
      await lockParentFlowForStage(tx, row.stageRecordId)
      await tx`SELECT id FROM task_flow_stage WHERE id=${row.stageRecordId}::uuid FOR UPDATE`
    }
    for (const row of input.rows) await insertText(tx, input.spaceId, row)
    return { revisions: {} }
  },
  'delete-text': async (tx, input) => {
    await lockParentFlowForStage(tx, input.stageRecordId)
    await tx`SELECT id FROM task_flow_stage WHERE id=${input.stageRecordId}::uuid FOR UPDATE`
    await deleteTexts(tx, input.spaceId, input.stageRecordId, input.ids)
    return { revisions: {} }
  },
  'copy-text': async (tx, input) => {
    await lockParentFlowForStage(tx, input.row.stageRecordId)
    await tx`SELECT id FROM task_flow_stage WHERE id=${input.row.stageRecordId}::uuid FOR UPDATE`
    await insertCopy(tx, input.spaceId, input.row)
    return { revisions: {} }
  },
}

export async function writeRecordTaskFlow<K extends TaskFlowIntent>(
  intent: K,
  input: Tenant & TaskFlowIntentBody<K>,
): Promise<TaskFlowWriteResult> {
  try {
    return await recordPool(input.url).begin(async (tx) => {
      await bindTenant(tx, input)
      return intentAppliers[intent](tx, input)
    })
  } catch (error) {
    const slot = isUniqueViolation(error, 'task_flow_stage_open_slot_unique')
    const number = isUniqueViolation(error, 'task_flow_stage_project_number_unique')
    if (slot || number)
      throw new DocRevisionConflictError(
        'another open stage holds that slot and must be closed or abandoned first',
        slot
          ? 'task_flow_stage.(project_id,workflow,mode,workflow_key,instance_id)'
          : 'task_flow_stage.(project_id,number)',
        'already-exists',
        null,
      )
    const state = postgresSqlState(error)
    if (state === '23505' || state === '23503') {
      const constraint = postgresConstraint(error) ?? '<unknown>'
      throw new DocRevisionConflictError(
        `${postgresBlockedRow(error)} blocked the task-flow write`,
        `constraint=${constraint}`,
        state === '23505' ? 'already-exists' : 'stale-revision',
        null,
      )
    }
    throw error
  }
}

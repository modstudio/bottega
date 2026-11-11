// concern: SQLite task-flow intent writes
/** Applies the hosted record's task-flow intent vocabulary to the local-only store. */

import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import type {
  TaskFlowIntent,
  TaskFlowIntentInput,
  TaskFlowIntentResult,
} from '../record/record-task-flow-write-contract.ts'

type Mutation = { id: string; expectedRevision: number; values: Record<string, unknown> }

const flowColumns: Record<string, string> = {
  taskId: 'task_record_id',
  state: 'state',
  openStageRecordId: 'open_stage_cursor_record_id',
  openingMachineId: 'opening_machine_id',
  updatedMachineId: 'updated_machine_id',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
}

const stageColumns: Record<string, string> = {
  flowRecordId: 'task_flow_record_id',
  workflowKey: 'workflow_key',
  instanceId: 'instance_id',
  sessionId: 'session_id',
  arguments: 'args',
  activeOrdinal: 'ordinal',
  activeSlug: 'step_slug',
  state: 'state',
  closedStepNotes: 'closed',
  question: 'question',
  autonomy: 'autonomy',
  enforcement: 'enforcement',
  openedMachineId: 'opened_machine_id',
  takenOverFromMachineId: 'taken_over_from_machine_id',
  lastAdvancedMachineId: 'last_advanced_machine_id',
  updatedAt: 'updated_at',
}

const jsonValues = new Set(['arguments', 'closedStepNotes', 'satisfiedEvidence'])

function storedValue(key: string, value: unknown): unknown {
  return jsonValues.has(key) ? JSON.stringify(value) : value
}

function cursorNumber(database: Database, recordId: string): number | string {
  return (
    database
      .query<{ number: number }, [string]>('SELECT number FROM workflow_cursor WHERE record_id=?')
      .get(recordId)?.number ?? recordId
  )
}

function revisionRefusal(database: Database, intent: TaskFlowIntent, mutation: Mutation): never {
  if (intent === 'compose' && flowColumns) {
    if (database.query('SELECT 1 FROM task_flow WHERE record_id=?').get(mutation.id))
      throw new Error(`task flow ${mutation.id} changed while composing; rerun the command`)
  }
  const cursor = cursorNumber(database, mutation.id)
  const values = mutation.values
  if (intent === 'advance')
    throw new Error(`workflow cursor ${cursor} changed while it advanced; rerun the command`)
  if (intent === 'await-ruling')
    throw new Error(`workflow cursor ${cursor} changed while awaiting a ruling; rerun the command`)
  if (intent === 'abandon')
    throw new Error(`workflow cursor ${cursor} changed while it was abandoned; rerun the command`)
  if (intent === 'adopt')
    throw new Error(
      `workflow cursor ${cursor} changed while its task was linked; rerun the command`,
    )
  if (intent === 'stage-update') return stageUpdateRevisionRefusal(cursor, values)
  throw new Error(`workflow cursor ${cursor} changed; rerun the command`)
}

function stageUpdateRevisionRefusal(
  cursor: number | string,
  values: Record<string, unknown>,
): never {
  if ('workflowKey' in values)
    throw new Error(
      `workflow cursor ${cursor} changed while adopting ${String(values.workflowKey)}; rerun the command`,
    )
  if ('activeOrdinal' in values)
    throw new Error(
      `workflow cursor ${cursor} changed while its step was served; rerun the command`,
    )
  if (values.state === 'running' && values.question === null)
    throw new Error(
      `workflow cursor ${cursor} changed while its ruling was recorded; rerun the command`,
    )
  throw new Error(`workflow cursor ${cursor} changed while composing; rerun the command`)
}

function revision(database: Database, table: string, id: string): number | null {
  return (
    database
      .prepare<{ revision: number }, [string]>(`SELECT revision FROM ${table} WHERE record_id=?`)
      .get(id)?.revision ?? null
  )
}

function updateMutation(
  database: Database,
  table: 'task_flow' | 'workflow_cursor',
  columns: Record<string, string>,
  mutation: Mutation,
  intent: TaskFlowIntent,
  applied: Record<string, number> | undefined,
): number {
  if (revision(database, table, mutation.id) !== mutation.expectedRevision)
    revisionRefusal(database, intent, mutation)
  const entries = Object.entries(mutation.values)
  const next = applied?.[mutation.id] ?? mutation.expectedRevision + 1
  const assignments = entries.map(([key]) => `${columns[key]}=?`)
  const values = entries.map(([key, value]) => storedValue(key, value))
  database
    .prepare(`UPDATE ${table} SET ${[...assignments, 'revision=?'].join(',')} WHERE record_id=?`)
    .run(...values, next, mutation.id)
  return next
}

function insertFlow(database: Database, row: Record<string, unknown>, revisionValue: number): void {
  database
    .query(`INSERT INTO task_flow
      (record_id,task_record_id,project_record_id,state,open_stage_cursor_record_id,created_at,updated_at,
       opening_machine_id,updated_machine_id,revision)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(
      row.id,
      row.taskId,
      row.projectId,
      row.state,
      row.openStageRecordId,
      row.createdAt,
      row.updatedAt,
      row.openingMachineId,
      row.updatedMachineId,
      revisionValue,
    )
}

function insertStage(
  database: Database,
  row: Record<string, unknown>,
  revisionValue: number,
): { id: string; number: number } {
  const project = database
    .query<{ name: string }, [string]>('SELECT name FROM project WHERE record_id=?')
    .get(String(row.projectId))?.name
  if (!project)
    throw new Error(`project ${String(row.projectId)} does not exist; register it, then retry`)
  const flow = database
    .query<{ task_record_id: string }, [string]>(
      'SELECT task_record_id FROM task_flow WHERE record_id=?',
    )
    .get(String(row.flowRecordId))
  const number = database
    .query<{ n: number }, []>('SELECT COALESCE(MAX(number),0)+1 n FROM workflow_cursor')
    .get()!.n
  database
    .query(`INSERT INTO workflow_cursor
      (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,task_record_id,
       task_flow_record_id,instance_id,session_id,workflow_version_record_id,catalogue_version_record_id,
       args,autonomy,ordinal,step_slug,state,closed,question,total_steps,created_at,updated_at,enforcement,
       opened_machine_id,taken_over_from_machine_id,last_advanced_machine_id,revision)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      row.id,
      number,
      project,
      row.projectId,
      row.workflow,
      row.mode,
      row.workflowKey,
      flow?.task_record_id ?? null,
      flow ? row.flowRecordId : null,
      row.instanceId,
      row.sessionId,
      row.workflowVersionId,
      row.catalogueVersionId,
      JSON.stringify(row.arguments),
      row.autonomy,
      row.activeOrdinal,
      row.activeSlug,
      row.state,
      JSON.stringify(row.closedStepNotes),
      row.question,
      row.totalSteps,
      row.createdAt,
      row.updatedAt,
      row.enforcement,
      row.openedMachineId,
      row.takenOverFromMachineId,
      row.lastAdvancedMachineId,
      revisionValue,
    )
  return { id: String(row.id), number }
}

function insertObligation(database: Database, row: Record<string, unknown>): void {
  database
    .query(`INSERT INTO workflow_obligation
    (record_id,cursor_record_id,step_ordinal,step_slug,floor,require_pull_request,operator_ruling,
     expected_exit_code,expected_status,floor_deferrable,reason,session_id,created_at,satisfied_at,
     satisfied_step_ordinal,satisfied_step_slug,satisfied_evidence,abandoned_at,abandoned_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      row.id,
      row.stageRecordId,
      row.stepOrdinal,
      row.stepSlug,
      row.floor,
      Number(row.requirePullRequest),
      Number(row.operatorRuling),
      row.expectedExitCode,
      row.expectedStatus,
      Number(row.floorDeferrable),
      row.reason,
      row.sessionId,
      row.createdAt,
      row.satisfiedAt,
      row.satisfiedStepOrdinal,
      row.satisfiedStepSlug,
      storedValue('satisfiedEvidence', row.satisfiedEvidence),
      row.abandonedAt,
      row.abandonedReason,
    )
}

function updateObligation(database: Database, row: Record<string, unknown>): void {
  const entries = Object.entries(row).filter(([key]) => key !== 'id' && key !== 'stageRecordId')
  const names: Record<string, string> = {
    satisfiedAt: 'satisfied_at',
    satisfiedStepOrdinal: 'satisfied_step_ordinal',
    satisfiedStepSlug: 'satisfied_step_slug',
    satisfiedEvidence: 'satisfied_evidence',
    abandonedAt: 'abandoned_at',
    abandonedReason: 'abandoned_reason',
  }
  const result = database
    .prepare(`UPDATE workflow_obligation SET ${entries.map(([key]) => `${names[key]}=?`).join(',')}
    WHERE record_id=? AND cursor_record_id=?`)
    .run(...entries.map(([key, value]) => storedValue(key, value)), row.id, row.stageRecordId)
  if (result.changes !== 1)
    throw new Error(`workflow obligation ${String(row.id)} changed; rerun the command`)
}

function deleteTexts(database: Database, stageRecordId: string, ids: readonly string[]): void {
  const remove = database.query(
    'DELETE FROM workflow_step_text WHERE record_id=? AND cursor_record_id=?',
  )
  for (const id of ids) remove.run(id, stageRecordId)
}

function applyStageMutation(
  database: Database,
  intent: 'advance' | 'await-ruling' | 'abandon',
  body: Record<string, unknown>,
  revisions: Record<string, number> | undefined,
): Record<string, number> {
  const result: Record<string, number> = {}
  const flow = body.flow as Mutation | undefined
  const stage = body.stage as Mutation
  if (flow)
    result[flow.id] = updateMutation(database, 'task_flow', flowColumns, flow, intent, revisions)
  result[stage.id] = updateMutation(
    database,
    'workflow_cursor',
    stageColumns,
    stage,
    intent,
    revisions,
  )
  for (const row of (body.obligationInserts as Record<string, unknown>[] | undefined) ?? [])
    insertObligation(database, row)
  for (const row of (body.obligationUpdates as Record<string, unknown>[] | undefined) ?? [])
    updateObligation(database, row)
  deleteTexts(database, stage.id, (body.deleteTextIds as string[] | undefined) ?? [])
  return result
}

function sourceFlowForAdopt(
  database: Database,
  stageId: string,
  body: Record<string, unknown>,
  applied: { revisions: Record<string, number>; flowRecordId: string } | undefined,
): { record_id: string; revision: number; task_record_id: string | null } {
  const source = database
    .query<{ record_id: string; revision: number; task_record_id: string | null }, [string]>(
      `SELECT f.record_id,f.revision,f.task_record_id FROM task_flow f JOIN workflow_cursor c
     ON c.task_flow_record_id=f.record_id WHERE c.record_id=?`,
    )
    .get(stageId)
  if (source) return source
  const project = database
    .query<{ project_record_id: string }, [string]>(
      'SELECT project_record_id FROM workflow_cursor WHERE record_id=?',
    )
    .get(stageId)!
  const flowRecordId = applied?.flowRecordId ?? newRecordId()
  database
    .query(`INSERT INTO task_flow
      (record_id,task_record_id,project_record_id,state,open_stage_cursor_record_id,created_at,updated_at,
       opening_machine_id,updated_machine_id,revision) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(
      flowRecordId,
      body.taskId,
      project.project_record_id,
      body.state ?? 'open',
      stageId,
      body.updatedAt,
      body.updatedAt,
      body.updatedMachineId,
      body.updatedMachineId,
      applied?.revisions[flowRecordId] ?? 1,
    )
  return {
    record_id: flowRecordId,
    revision: applied?.revisions[flowRecordId] ?? 1,
    task_record_id: String(body.taskId),
  }
}

function applyAdopt(
  database: Database,
  body: Record<string, unknown>,
  applied: { revisions: Record<string, number>; flowRecordId: string } | undefined,
) {
  const stage = body.stage as { id: string; expectedRevision: number }
  if (revision(database, 'workflow_cursor', stage.id) !== stage.expectedRevision)
    revisionRefusal(database, 'adopt', { ...stage, values: {} })
  const source = sourceFlowForAdopt(database, stage.id, body, applied)
  const target = database
    .query<{ record_id: string; revision: number }, [string]>(
      'SELECT record_id,revision FROM task_flow WHERE task_record_id=?',
    )
    .get(String(body.taskId))
  const flowRecordId = applied?.flowRecordId ?? target?.record_id ?? source.record_id
  const revisions = applied?.revisions ?? {}
  if (target && target.record_id !== source.record_id) {
    database
      .query(
        "UPDATE task_flow SET state='dropped',open_stage_cursor_record_id=NULL,updated_machine_id=?,updated_at=?,revision=? WHERE record_id=?",
      )
      .run(
        body.updatedMachineId,
        body.updatedAt,
        revisions[source.record_id] ?? source.revision + 1,
        source.record_id,
      )
    database
      .query(
        'UPDATE task_flow SET open_stage_cursor_record_id=?,updated_machine_id=?,updated_at=?,revision=? WHERE record_id=?',
      )
      .run(
        stage.id,
        body.updatedMachineId,
        body.updatedAt,
        revisions[target.record_id] ?? target.revision + 1,
        target.record_id,
      )
  } else {
    database
      .query(
        'UPDATE task_flow SET task_record_id=?,open_stage_cursor_record_id=?,updated_machine_id=?,updated_at=?,revision=? WHERE record_id=?',
      )
      .run(
        body.taskId,
        stage.id,
        body.updatedMachineId,
        body.updatedAt,
        revisions[source.record_id] ?? source.revision + 1,
        source.record_id,
      )
  }
  const stageRevision = revisions[stage.id] ?? stage.expectedRevision + 1
  database
    .query(
      'UPDATE workflow_cursor SET task_record_id=?,task_flow_record_id=?,last_advanced_machine_id=?,updated_at=?,revision=? WHERE record_id=?',
    )
    .run(body.taskId, flowRecordId, body.updatedMachineId, body.updatedAt, stageRevision, stage.id)
  return {
    revisions: {
      ...revisions,
      [stage.id]: stageRevision,
      [flowRecordId]: revisions[flowRecordId] ?? (target?.revision ?? source.revision) + 1,
    },
    flowRecordId,
  }
}

function writeCompose(
  database: Database,
  body: Record<string, unknown>,
  applied: TaskFlowIntentResult<'compose'> | null | undefined,
): TaskFlowIntentResult<'compose'> {
  const revisions = applied?.revisions
  const result: Record<string, number> = {}
  const appliedCompose = applied as
    | { revisions: Record<string, number>; stage: { id: string; number: number } | null }
    | null
    | undefined
  const payloadStage = body.stageInsert as Record<string, unknown> | undefined
  const stageId = appliedCompose?.stage?.id ?? (payloadStage ? String(payloadStage.id) : null)
  const appliedFlowId = appliedCompose
    ? Object.keys(appliedCompose.revisions).find((id) => id !== stageId)
    : undefined
  const keepsLocalFlow = Boolean(payloadStage?.workflowKey)
  const rawFlowInsert = keepsLocalFlow
    ? (body.flowInsert as Record<string, unknown> | undefined)
    : undefined
  const flowInsert = rawFlowInsert
    ? {
        ...rawFlowInsert,
        id: appliedFlowId ?? rawFlowInsert.id,
        openStageRecordId: stageId ?? rawFlowInsert.openStageRecordId,
      }
    : undefined
  let stage: { id: string; number: number } | null = null
  if (payloadStage) {
    const row = {
      ...payloadStage,
      id: stageId,
      flowRecordId: keepsLocalFlow ? (appliedFlowId ?? payloadStage.flowRecordId) : null,
    }
    if (row.workflowKey && row.instanceId === '')
      database
        .query(`UPDATE workflow_cursor SET instance_id=instance_id || '#' || number
            WHERE project_record_id=? AND workflow_slug=? AND mode_slug=? AND workflow_key=?
              AND instance_id='' AND record_id<>? AND state IN ('done','abandoned')`)
        .run(row.projectId, row.workflow, row.mode, row.workflowKey, row.id)
    const next = revisions?.[String(row.id)] ?? 1
    stage = insertStage(database, row, next)
    result[String(row.id)] = next
  }
  // Local task_flow.task_record_id is NOT NULL (orchestrator/migrations/0198_task_flow.sql).
  // Until the handle/schema slices, an unlinked compose keeps today's flow-less local shape.
  if (flowInsert?.taskId != null) {
    const next = revisions?.[String(flowInsert.id)] ?? 1
    insertFlow(database, flowInsert, next)
    result[String(flowInsert.id)] = next
    if (stage)
      database
        .query(
          'UPDATE workflow_cursor SET task_record_id=?,task_flow_record_id=? WHERE record_id=?',
        )
        .run(flowInsert.taskId, flowInsert.id, stage.id)
  }
  const flowChange = keepsLocalFlow ? (body.flowChange as Mutation | undefined) : undefined
  if (flowChange)
    result[flowChange.id] = updateMutation(
      database,
      'task_flow',
      flowColumns,
      flowChange,
      'compose',
      revisions,
    )
  for (const change of (body.stageChanges as Mutation[] | undefined) ?? [])
    result[change.id] = updateMutation(
      database,
      'workflow_cursor',
      stageColumns,
      change,
      'compose',
      revisions,
    )
  // The record number is per project while SQLite handles remain machine-wide until 2c-2d.
  return { revisions: result, stage }
}

function writeStageUpdate(
  database: Database,
  body: Record<string, unknown>,
  revisions?: Record<string, number>,
) {
  const result: Record<string, number> = {}
  const flow = body.flow as Mutation | undefined
  if (flow)
    result[flow.id] = updateMutation(
      database,
      'task_flow',
      flowColumns,
      flow,
      'stage-update',
      revisions,
    )
  for (const stage of body.stages as Mutation[])
    result[stage.id] = updateMutation(
      database,
      'workflow_cursor',
      stageColumns,
      stage,
      'stage-update',
      revisions,
    )
  return { revisions: result }
}

function writeTextIntent(
  database: Database,
  intent: 'attach-text' | 'delete-text' | 'copy-text',
  body: Record<string, unknown>,
) {
  if (intent === 'attach-text') {
    for (const row of body.rows as Record<string, unknown>[])
      database
        .query(
          'INSERT INTO workflow_step_text(record_id,cursor_record_id,step_ordinal,step_slug,body,created_at) VALUES (?,?,?,?,?,?)',
        )
        .run(row.id, row.stageRecordId, row.stepOrdinal, row.stepSlug, row.body, row.createdAt)
  } else if (intent === 'delete-text')
    deleteTexts(database, String(body.stageRecordId), body.ids as string[])
  else {
    const row = body.row as Record<string, unknown>
    database
      .query(`INSERT OR IGNORE INTO workflow_text_copy
      (record_id,workflow_text_record_id,cursor_record_id,task_document_reference,copied_at) VALUES (?,?,?,?,?)`)
      .run(
        row.id,
        row.workflowTextRecordId,
        row.stageRecordId,
        row.taskDocumentReference,
        row.copiedAt,
      )
  }
  return { revisions: {} }
}

export function writeSqliteTaskFlow<K extends TaskFlowIntent>(
  database: Database,
  intent: K,
  payload: TaskFlowIntentInput<K>,
  applied?: TaskFlowIntentResult<K> | null,
): TaskFlowIntentResult<K> {
  const body = payload as Record<string, unknown>
  const revisions = (applied as { revisions: Record<string, number> } | null | undefined)?.revisions
  if (intent === 'compose')
    return writeCompose(
      database,
      body,
      applied as TaskFlowIntentResult<'compose'> | null,
    ) as TaskFlowIntentResult<K>
  if (intent === 'stage-update')
    return writeStageUpdate(database, body, revisions) as TaskFlowIntentResult<K>
  if (intent === 'advance' || intent === 'await-ruling' || intent === 'abandon')
    return {
      revisions: applyStageMutation(database, intent, body, revisions),
    } as TaskFlowIntentResult<K>
  if (intent === 'adopt')
    return applyAdopt(
      database,
      body,
      applied as { revisions: Record<string, number>; flowRecordId: string } | undefined,
    ) as TaskFlowIntentResult<K>
  return writeTextIntent(
    database,
    intent as 'attach-text' | 'delete-text' | 'copy-text',
    body,
  ) as TaskFlowIntentResult<K>
}

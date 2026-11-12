// concern: SQLite task-flow intent writes
/** Applies the hosted record's task-flow intent vocabulary to the local-only store. */

import type { Database, SQLQueryBindings } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import type {
  TaskFlowIntent,
  TaskFlowIntentInput,
  TaskFlowIntentResult,
} from '../record/record-task-flow-write-contract.ts'
import {
  type AppliedMirrorMutationDecision,
  decideAppliedMirrorMutation,
} from './task-flow-decision.ts'

type Mutation = { id: string; expectedRevision: number; values: Record<string, unknown> }
type SqlRow = Record<string, SQLQueryBindings>
type AppliedMirrorOutcome = Exclude<AppliedMirrorMutationDecision, 'refuse'>
export type TaskFlowSqliteWriteResult<K extends TaskFlowIntent> = TaskFlowIntentResult<K> &
  (K extends 'adopt' ? { mirror: Record<string, AppliedMirrorOutcome> } : object)

const jsonValues = new Set(['arguments', 'closedStepNotes', 'satisfiedEvidence'])

function storedValue(key: string, value: unknown): SQLQueryBindings {
  if (jsonValues.has(key) || (typeof value === 'object' && value !== null))
    return JSON.stringify(value)
  return value as SQLQueryBindings
}

export type TaskFlowStaleRowKind = 'flow' | 'stage' | 'cursor'

const REVISION_ACTION: Record<TaskFlowIntent, string> = {
  compose: 'composing',
  'stage-update': 'applying a stage update',
  advance: 'advancing',
  'await-ruling': 'awaiting a ruling',
  abandon: 'being abandoned',
  adopt: 'linking its task',
  'attach-text': 'attaching text',
  'delete-text': 'deleting text',
  'copy-text': 'copying text',
}

const ROW_SUBJECT: Record<TaskFlowStaleRowKind, string> = {
  flow: 'task flow',
  stage: 'workflow stage',
  cursor: 'workflow cursor',
}

/** Chooses a stale-write refusal solely from the declared intent and row kind. */
export function taskFlowRevisionRefusal(
  intent: TaskFlowIntent,
  rowKind: TaskFlowStaleRowKind,
  identifier: string | number,
): string {
  return `${ROW_SUBJECT[rowKind]} ${identifier} changed while ${REVISION_ACTION[intent]}; rerun the command`
}

function revisionRefusal(
  database: Database,
  intent: TaskFlowIntent,
  table: 'task_flow' | 'workflow_cursor',
  id: string,
): never {
  if (table === 'task_flow') throw new Error(taskFlowRevisionRefusal(intent, 'flow', id))
  const cursor = database
    .query<{ number: number }, [string]>('SELECT number FROM workflow_cursor WHERE record_id=?')
    .get(id)?.number
  throw new Error(
    taskFlowRevisionRefusal(intent, cursor === undefined ? 'stage' : 'cursor', cursor ?? id),
  )
}

function revision(database: Database, table: string, id: string): number | null {
  const query =
    table === 'task_flow'
      ? database.query<{ revision: number }, [string]>(
          'SELECT revision FROM task_flow WHERE record_id=?',
        )
      : database.query<{ revision: number }, [string]>(
          'SELECT revision FROM workflow_cursor WHERE record_id=?',
        )
  return query.get(id)?.revision ?? null
}

function applyFlowValues(database: Database, mutation: Mutation, next: number): void {
  const value = (key: string) =>
    key in mutation.values ? storedValue(key, mutation.values[key]) : null
  database
    .query(`UPDATE task_flow SET
    state=COALESCE(?,state),open_stage_cursor_record_id=CASE WHEN ? THEN ? ELSE open_stage_cursor_record_id END,
    opening_machine_id=COALESCE(?,opening_machine_id),updated_machine_id=COALESCE(?,updated_machine_id),
    created_at=COALESCE(?,created_at),updated_at=COALESCE(?,updated_at),revision=? WHERE record_id=?`)
    .run(
      value('state'),
      'openStageRecordId' in mutation.values,
      value('openStageRecordId'),
      value('openingMachineId'),
      value('updatedMachineId'),
      value('createdAt'),
      value('updatedAt'),
      next,
      mutation.id,
    )
}

function applyStageValues(database: Database, mutation: Mutation, next: number): void {
  const value = (key: string) =>
    key in mutation.values ? storedValue(key, mutation.values[key]) : null
  const nullable = (key: string) => [key in mutation.values, value(key)] as const
  const session = nullable('sessionId'),
    question = nullable('question'),
    autonomy = nullable('autonomy')
  const takeover = nullable('takenOverFromMachineId')
  database
    .query(`UPDATE workflow_cursor SET task_flow_record_id=COALESCE(?,task_flow_record_id),
    workflow_key=COALESCE(?,workflow_key),instance_id=COALESCE(?,instance_id),
    session_id=CASE WHEN ? THEN ? ELSE session_id END,args=COALESCE(?,args),ordinal=COALESCE(?,ordinal),
    step_slug=COALESCE(?,step_slug),state=COALESCE(?,state),closed=COALESCE(?,closed),
    question=CASE WHEN ? THEN ? ELSE question END,autonomy=CASE WHEN ? THEN ? ELSE autonomy END,
    enforcement=COALESCE(?,enforcement),opened_machine_id=COALESCE(?,opened_machine_id),
    taken_over_from_machine_id=CASE WHEN ? THEN ? ELSE taken_over_from_machine_id END,
    last_advanced_machine_id=COALESCE(?,last_advanced_machine_id),updated_at=COALESCE(?,updated_at),revision=?
    WHERE record_id=?`)
    .run(
      value('flowRecordId'),
      value('workflowKey'),
      value('instanceId'),
      ...session,
      value('arguments'),
      value('activeOrdinal'),
      value('activeSlug'),
      value('state'),
      value('closedStepNotes'),
      ...question,
      ...autonomy,
      value('enforcement'),
      value('openedMachineId'),
      ...takeover,
      value('lastAdvancedMachineId'),
      value('updatedAt'),
      next,
      mutation.id,
    )
}

function updateMutation(
  database: Database,
  table: 'task_flow' | 'workflow_cursor',
  mutation: Mutation,
  intent: TaskFlowIntent,
  applied: Record<string, number> | undefined,
): number {
  const next = applied?.[mutation.id] ?? mutation.expectedRevision + 1
  const current = revision(database, table, mutation.id)
  const decision = decideAppliedMirrorMutation(
    current,
    mutation.expectedRevision,
    applied?.[mutation.id],
  )
  if (decision === 'refuse') revisionRefusal(database, intent, table, mutation.id)
  if (decision !== 'apply') return next
  if (table === 'task_flow') applyFlowValues(database, mutation, next)
  else applyStageValues(database, mutation, next)
  return next
}

function insertFlow(database: Database, row: SqlRow, revisionValue: number): void {
  database
    .query(`INSERT INTO task_flow
      (record_id,task_record_id,project_record_id,state,open_stage_cursor_record_id,created_at,updated_at,
       opening_machine_id,updated_machine_id,revision)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(
      // @ts-expect-error The validated intent guarantees every required SQLite binding.
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
  row: SqlRow,
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
      // @ts-expect-error The validated intent guarantees every required SQLite binding.
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

function insertObligation(database: Database, row: SqlRow): void {
  database
    .query(`INSERT INTO workflow_obligation
    (record_id,cursor_record_id,step_ordinal,step_slug,floor,require_pull_request,operator_ruling,
     expected_exit_code,expected_status,floor_deferrable,reason,session_id,created_at,satisfied_at,
     satisfied_step_ordinal,satisfied_step_slug,satisfied_evidence,abandoned_at,abandoned_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      // @ts-expect-error The validated intent guarantees every required SQLite binding.
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

function updateObligation(database: Database, row: SqlRow): void {
  const value = (key: string) => (key in row ? storedValue(key, row[key]) : null)
  const pair = (key: string) => [key in row, value(key)] as const
  const result = database
    .query(`UPDATE workflow_obligation SET
    satisfied_at=CASE WHEN ? THEN ? ELSE satisfied_at END,
    satisfied_step_ordinal=CASE WHEN ? THEN ? ELSE satisfied_step_ordinal END,
    satisfied_step_slug=CASE WHEN ? THEN ? ELSE satisfied_step_slug END,
    satisfied_evidence=CASE WHEN ? THEN ? ELSE satisfied_evidence END,
    abandoned_at=CASE WHEN ? THEN ? ELSE abandoned_at END,
    abandoned_reason=CASE WHEN ? THEN ? ELSE abandoned_reason END
    WHERE record_id=? AND cursor_record_id=?`)
    .run(
      // @ts-expect-error The validated intent guarantees every required SQLite binding.
      ...pair('satisfiedAt'),
      ...pair('satisfiedStepOrdinal'),
      ...pair('satisfiedStepSlug'),
      ...pair('satisfiedEvidence'),
      ...pair('abandonedAt'),
      ...pair('abandonedReason'),
      row.id,
      row.stageRecordId,
    )
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
  body: SqlRow,
  revisions: Record<string, number> | undefined,
): Record<string, number> {
  const result: Record<string, number> = {}
  const flow = body.flow as Mutation | undefined
  const stage = body.stage as unknown as Mutation
  if (flow) result[flow.id] = updateMutation(database, 'task_flow', flow, intent, revisions)
  result[stage.id] = updateMutation(database, 'workflow_cursor', stage, intent, revisions)
  for (const row of (body.obligationInserts as SqlRow[] | undefined) ?? [])
    insertObligation(database, row)
  for (const row of (body.obligationUpdates as SqlRow[] | undefined) ?? [])
    updateObligation(database, row)
  deleteTexts(database, stage.id, (body.deleteTextIds as string[] | undefined) ?? [])
  return result
}

function sourceFlowForAdopt(
  database: Database,
  stageId: string,
  body: SqlRow,
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
      // @ts-expect-error The validated intent guarantees every required SQLite binding.
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
  body: SqlRow,
  applied: { revisions: Record<string, number>; flowRecordId: string } | undefined,
) {
  const stage = body.stage as { id: string; expectedRevision: number }
  const stageDecision = decideAppliedMirrorMutation(
    revision(database, 'workflow_cursor', stage.id),
    stage.expectedRevision,
    applied?.revisions[stage.id],
  )
  if (stageDecision === 'refuse') revisionRefusal(database, 'adopt', 'workflow_cursor', stage.id)
  if (stageDecision !== 'apply')
    return {
      revisions: applied!.revisions,
      flowRecordId: applied!.flowRecordId,
      mirror: { [stage.id]: stageDecision },
    }
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
        // @ts-expect-error The validated intent guarantees every required SQLite binding.
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
        // @ts-expect-error The validated intent guarantees every required SQLite binding.
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
        // @ts-expect-error The validated intent guarantees every required SQLite binding.
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
    // @ts-expect-error The validated intent guarantees every required SQLite binding.
    .run(body.taskId, flowRecordId, body.updatedMachineId, body.updatedAt, stageRevision, stage.id)
  return {
    revisions: {
      ...revisions,
      [stage.id]: stageRevision,
      [flowRecordId]: revisions[flowRecordId] ?? (target?.revision ?? source.revision) + 1,
    },
    flowRecordId,
    mirror: { [stage.id]: stageDecision },
  }
}

function writeCompose(
  database: Database,
  body: SqlRow,
  applied: TaskFlowIntentResult<'compose'> | null | undefined,
): TaskFlowIntentResult<'compose'> {
  const revisions = applied?.revisions
  const result: Record<string, number> = {}
  const appliedCompose = applied as
    | { revisions: Record<string, number>; stage: { id: string; number: number } | null }
    | null
    | undefined
  const payloadStage = body.stageInsert as SqlRow | undefined
  const stageId = appliedCompose?.stage?.id ?? (payloadStage ? String(payloadStage.id) : null)
  const appliedFlowId = appliedCompose
    ? Object.keys(appliedCompose.revisions).find((id) => id !== stageId)
    : undefined
  const keepsLocalFlow = Boolean(payloadStage?.workflowKey)
  const rawFlowInsert = keepsLocalFlow ? (body.flowInsert as SqlRow | undefined) : undefined
  const flowInsert: SqlRow | undefined = rawFlowInsert
    ? ({
        ...rawFlowInsert,
        id: appliedFlowId ?? rawFlowInsert.id,
        openStageRecordId: stageId ?? rawFlowInsert.openStageRecordId,
      } as unknown as SqlRow)
    : undefined
  let stage: { id: string; number: number } | null = null
  if (payloadStage) {
    const row = {
      ...payloadStage,
      id: stageId,
      flowRecordId: keepsLocalFlow ? (appliedFlowId ?? payloadStage.flowRecordId) : null,
    } as unknown as SqlRow
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
        // @ts-expect-error The validated intent guarantees every required SQLite binding.
        .run(flowInsert.taskId, flowInsert.id, stage.id)
  }
  const flowChange = keepsLocalFlow ? (body.flowChange as Mutation | undefined) : undefined
  if (flowChange)
    result[flowChange.id] = updateMutation(database, 'task_flow', flowChange, 'compose', revisions)
  for (const change of (body.stageChanges as Mutation[] | undefined) ?? [])
    result[change.id] = updateMutation(database, 'workflow_cursor', change, 'compose', revisions)
  // The record number is per project while SQLite handles remain machine-wide until 2c-2d.
  return { revisions: result, stage }
}

function writeStageUpdate(database: Database, body: SqlRow, revisions?: Record<string, number>) {
  const result: Record<string, number> = {}
  const flow = body.flow as Mutation | undefined
  if (flow) result[flow.id] = updateMutation(database, 'task_flow', flow, 'stage-update', revisions)
  for (const stage of body.stages as unknown as Mutation[])
    result[stage.id] = updateMutation(database, 'workflow_cursor', stage, 'stage-update', revisions)
  return { revisions: result }
}

function writeTextIntent(
  database: Database,
  intent: 'attach-text' | 'delete-text' | 'copy-text',
  body: SqlRow,
) {
  if (intent === 'attach-text') {
    for (const row of body.rows as unknown as SqlRow[])
      database
        .query(
          'INSERT INTO workflow_step_text(record_id,cursor_record_id,step_ordinal,step_slug,body,created_at) VALUES (?,?,?,?,?,?)',
        )
        // @ts-expect-error The validated intent guarantees every required SQLite binding.
        .run(row.id, row.stageRecordId, row.stepOrdinal, row.stepSlug, row.body, row.createdAt)
  } else if (intent === 'delete-text')
    deleteTexts(database, String(body.stageRecordId), body.ids as unknown as string[])
  else {
    const row = body.row as SqlRow
    database
      .query(`INSERT OR IGNORE INTO workflow_text_copy
      (record_id,workflow_text_record_id,cursor_record_id,task_document_reference,copied_at) VALUES (?,?,?,?,?)`)
      .run(
        // @ts-expect-error The validated intent guarantees every required SQLite binding.
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
): TaskFlowSqliteWriteResult<K> {
  const body = payload as unknown as SqlRow
  const revisions = (applied as { revisions: Record<string, number> } | null | undefined)?.revisions
  if (intent === 'compose')
    return writeCompose(
      database,
      body,
      applied as TaskFlowIntentResult<'compose'> | null,
    ) as unknown as TaskFlowSqliteWriteResult<K>
  if (intent === 'stage-update')
    return writeStageUpdate(database, body, revisions) as TaskFlowSqliteWriteResult<K>
  if (intent === 'advance' || intent === 'await-ruling' || intent === 'abandon')
    return {
      revisions: applyStageMutation(database, intent, body, revisions),
    } as TaskFlowSqliteWriteResult<K>
  if (intent === 'adopt')
    return applyAdopt(
      database,
      body,
      applied as { revisions: Record<string, number>; flowRecordId: string } | undefined,
    ) as TaskFlowSqliteWriteResult<K>
  return writeTextIntent(
    database,
    intent as 'attach-text' | 'delete-text' | 'copy-text',
    body,
  ) as TaskFlowSqliteWriteResult<K>
}

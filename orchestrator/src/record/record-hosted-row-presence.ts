// concern: hosted workflow-history presence
/** Collects local hosted-history ids and reads their record presence in bounded batches. */

import type { Database } from 'bun:sqlite'
import { TASK_FLOW_PRESENCE_BATCH_MAX, type TaskFlowPresence } from './record-task-flow-contract.ts'

export const HOSTED_ROW_TABLES = [
  'workflow_obligation',
  'workflow_step_text',
  'workflow_text_copy',
  'question_mutation_audit',
  'question',
  'workflow_cursor',
  'task_flow',
] as const

export type HostedRowTable = (typeof HOSTED_ROW_TABLES)[number]
export type HostedRowIds = Record<HostedRowTable, ReadonlySet<string>>
export type HostedRowReferences = {
  obligationCursor: ReadonlyMap<string, string>
  stepTextCursor: ReadonlyMap<string, string>
  textCopyCursor: ReadonlyMap<string, string>
  auditQuestion: ReadonlyMap<string, string>
  questionCursor: ReadonlyMap<string, string>
  cursorFlow: ReadonlyMap<string, string>
  cursorHandoff: ReadonlyMap<string, string>
  flowOpenCursor: ReadonlyMap<string, string>
}
export type HostedRowState = { ids: HostedRowIds; references: HostedRowReferences }
export type PresenceReader = (input: TaskFlowPresence) => Promise<TaskFlowPresence>

const PRESENCE_FIELDS = {
  workflow_obligation: 'obligationIds',
  workflow_step_text: 'textIds',
  workflow_text_copy: 'textCopyIds',
  question_mutation_audit: 'questionAuditIds',
  question: 'questionIds',
  workflow_cursor: 'stageIds',
  task_flow: 'flowIds',
} as const satisfies Record<HostedRowTable, keyof TaskFlowPresence>

export function emptyHostedRowIds(): Record<HostedRowTable, Set<string>> {
  return Object.fromEntries(HOSTED_ROW_TABLES.map((table) => [table, new Set<string>()])) as Record<
    HostedRowTable,
    Set<string>
  >
}

export function hostedRowIdsAreEmpty(ids: HostedRowIds): boolean {
  return HOSTED_ROW_TABLES.every((table) => ids[table].size === 0)
}

function referenceMap(
  source: readonly Record<string, unknown>[],
  field: string,
): Map<string, string> {
  return new Map(
    source.flatMap((row) =>
      row[field] == null ? [] : [[String(row.record_id), String(row[field])] as const],
    ),
  )
}

/** Read the seven local hosted tables and their within-set parent references. */
export function collectHostedRowState(database: Database): HostedRowState {
  const collected: Record<HostedRowTable, Record<string, unknown>[]> = {
    workflow_obligation: database
      .query<Record<string, unknown>, []>('SELECT * FROM workflow_obligation')
      .all(),
    workflow_step_text: database
      .query<Record<string, unknown>, []>('SELECT * FROM workflow_step_text')
      .all(),
    workflow_text_copy: database
      .query<Record<string, unknown>, []>('SELECT * FROM workflow_text_copy')
      .all(),
    question_mutation_audit: database
      .query<Record<string, unknown>, []>('SELECT * FROM question_mutation_audit')
      .all(),
    question: database.query<Record<string, unknown>, []>('SELECT * FROM question').all(),
    workflow_cursor: database
      .query<Record<string, unknown>, []>('SELECT * FROM workflow_cursor')
      .all(),
    task_flow: database.query<Record<string, unknown>, []>('SELECT * FROM task_flow').all(),
  }
  const ids = Object.fromEntries(
    HOSTED_ROW_TABLES.map((table) => [
      table,
      new Set(collected[table].map((row) => String(row.record_id))),
    ]),
  ) as Record<HostedRowTable, Set<string>>
  return {
    ids,
    references: {
      obligationCursor: referenceMap(collected.workflow_obligation, 'cursor_record_id'),
      stepTextCursor: referenceMap(collected.workflow_step_text, 'cursor_record_id'),
      textCopyCursor: referenceMap(collected.workflow_text_copy, 'cursor_record_id'),
      auditQuestion: referenceMap(collected.question_mutation_audit, 'question_record_id'),
      questionCursor: referenceMap(collected.question, 'workflow_cursor_record_id'),
      cursorFlow: referenceMap(collected.workflow_cursor, 'task_flow_record_id'),
      cursorHandoff: referenceMap(collected.workflow_cursor, 'handed_off_from_record_id'),
      flowOpenCursor: referenceMap(collected.task_flow, 'open_stage_cursor_record_id'),
    },
  }
}

function presenceRequest(local: HostedRowIds, batch: number): TaskFlowPresence {
  const offset = batch * TASK_FLOW_PRESENCE_BATCH_MAX
  const chunk = (table: HostedRowTable) =>
    [...local[table]].slice(offset, offset + TASK_FLOW_PRESENCE_BATCH_MAX)
  return {
    obligationIds: chunk('workflow_obligation'),
    textIds: chunk('workflow_step_text'),
    textCopyIds: chunk('workflow_text_copy'),
    questionAuditIds: chunk('question_mutation_audit'),
    questionIds: chunk('question'),
    stageIds: chunk('workflow_cursor'),
    flowIds: chunk('task_flow'),
  }
}

/** Read presence for all supplied ids, chunked per table to the record contract limit. */
export async function readHostedRowPresence(
  local: HostedRowIds,
  read: PresenceReader,
): Promise<HostedRowIds> {
  const present = emptyHostedRowIds()
  const batches = Math.max(
    ...HOSTED_ROW_TABLES.map((table) =>
      Math.ceil(local[table].size / TASK_FLOW_PRESENCE_BATCH_MAX),
    ),
  )
  for (let batch = 0; batch < batches; batch += 1) {
    const response = await read(presenceRequest(local, batch))
    for (const table of HOSTED_ROW_TABLES)
      for (const id of response[PRESENCE_FIELDS[table]]) present[table].add(id)
  }
  return present
}

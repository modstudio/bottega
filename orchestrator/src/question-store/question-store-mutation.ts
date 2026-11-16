// concern: question-store snapshot mutations
/** Converts port reads into the validated snapshot writes shared by both adapters. */

import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { machineId } from '../record/machine-identity.ts'
import type { QuestionIntent, QuestionWriteBody } from '../record/record-question-contract.ts'
import { enqueueQuestionRecord } from '../run/question-outbox.ts'
import { questionStore } from './question-store.ts'

type Snapshot = QuestionWriteBody['question']
const nullable = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const json = (value: unknown): unknown => {
  if (typeof value !== 'string') return value ?? null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function questionSnapshotFromRow(row: Record<string, unknown>): Snapshot {
  const askedAt = String(row.asked_at)
  return {
    id: String(row.record_id),
    number: row.number == null ? null : Number(row.number),
    runId: nullable(row.run_record_id),
    workflowKey: nullable(row.workflow_key),
    workflowTaskId: nullable(row.workflow_task_record_id),
    workflowCursorRecordId: nullable(row.workflow_cursor_record_id),
    projectId: nullable(row.project_record_id),
    machineId: nullable(row.machine_id) ?? machineId(),
    revision: Number(row.revision),
    askedAt,
    question: String(row.question),
    options: json(row.options),
    recommendation: nullable(row.recommendation),
    why: nullable(row.why),
    askedVia: nullable(row.asked_via),
    kind: nullable(row.kind),
    typedOptions: json(row.typed_options),
    criteria: json(row.criteria),
    levels: json(row.levels),
    answer: nullable(row.answer),
    answerValue: nullable(row.answer_value),
    answerBasis: nullable(row.answer_basis),
    answeredAt: nullable(row.answered_at),
    answeredBy: nullable(row.answered_by),
    answeredByName: nullable(row.answered_by_name),
    answeredByKind: nullable(row.answered_by_kind),
    answererKind: nullable(row.answerer_kind),
    answerChannel: nullable(row.answer_channel),
    jevPick: nullable(row.jev_pick),
    jevConfidence: row.jev_confidence == null ? null : Number(row.jev_confidence),
    jevProbabilities: json(row.jev_probabilities),
    jevModel: nullable(row.jev_model),
    jevInputTokens: row.jev_input_tokens == null ? null : Number(row.jev_input_tokens),
    jevError: nullable(row.jev_error),
    jevAgreed: row.jev_agreed == null ? null : Number(row.jev_agreed),
    jevQuestionVersion: row.jev_question_version == null ? null : Number(row.jev_question_version),
    jevFits: row.jev_fits == null ? null : Number(row.jev_fits),
    jevOrderFlipped: row.jev_order_flipped == null ? null : Number(row.jev_order_flipped),
    awaitingOperatorAt: nullable(row.awaiting_operator_at),
    relayedBy: nullable(row.relayed_by),
    overturnedAt: nullable(row.overturned_at),
    overturnedBy: nullable(row.overturned_by),
    overturnedByName: nullable(row.overturned_by_name),
    overturnReason: nullable(row.overturn_reason),
    replacement: nullable(row.replacement),
    filedAs: nullable(row.filed_as),
    filedRef: nullable(row.filed_ref),
    filedRecordId: nullable(row.filed_record_id),
    filedLabel: nullable(row.filed_label),
    filedAt: nullable(row.filed_at),
    closedAt: nullable(row.closed_at),
    closeReason: nullable(row.close_reason),
    withheldFields: Array.isArray(row.withheld_fields) ? row.withheld_fields.map(String) : [],
    createdAt: nullable(row.created_at) ?? askedAt,
    updatedAt: nullable(row.updated_at) ?? askedAt,
  }
}

export async function questionById(
  database: Database,
  id: string,
): Promise<Record<string, unknown> | null> {
  return (
    ((await questionStore(database).read({ read: 'by-id', ids: [id] })).items[0] as
      | Record<string, unknown>
      | undefined) ?? null
  )
}

export async function mutateQuestion(
  database: Database,
  input: {
    id: string
    intent: QuestionIntent
    at: string
    actorSession: string | null
    reason: string | null
    changes: Partial<Snapshot>
    expectedRevision?: number
  },
) {
  const row = await questionById(database, input.id)
  if (!row) throw new Error(`question ${input.id} not found`)
  const current = questionSnapshotFromRow(row)
  if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision)
    throw new Error(`question ${input.id} changed before the mutation was stored`)
  const result = await questionStore(database).write(input.intent, {
    requestId: newRecordId(),
    question: {
      ...current,
      ...input.changes,
      revision: current.revision + 1,
      updatedAt: input.at,
    },
    audit: {
      action: input.intent,
      actorSession: input.actorSession,
      at: input.at,
      reason: input.reason,
    },
  })
  enqueueQuestionRecord(database, input.id)
  return result
}

export async function askQuestion(
  database: Database,
  input: {
    id?: string
    runId?: string | null
    workflowCursorRecordId?: string | null
    workflowKey?: string | null
    workflowTaskId?: string | null
    projectId?: string | null
    askedAt: string
    question: string
    options?: unknown
    recommendation?: string | null
    why?: string | null
    askedVia?: string | null
    awaitingOperatorAt?: string | null
    kind?: string | null
    typedOptions?: unknown
    criteria?: unknown
    levels?: unknown
  },
) {
  const id = input.id ?? newRecordId()
  const question: Snapshot = {
    id,
    number: null,
    runId: input.runId ?? null,
    workflowKey: input.workflowKey ?? null,
    workflowTaskId: input.workflowTaskId ?? null,
    workflowCursorRecordId: input.workflowCursorRecordId ?? null,
    projectId: input.projectId ?? null,
    machineId: machineId(),
    revision: 1,
    askedAt: input.askedAt,
    question: input.question,
    options: input.options ?? null,
    recommendation: input.recommendation ?? null,
    why: input.why ?? null,
    askedVia: input.askedVia ?? null,
    kind: input.kind ?? null,
    typedOptions: input.typedOptions ?? null,
    criteria: input.criteria ?? null,
    levels: input.levels ?? null,
    answer: null,
    answerValue: null,
    answerBasis: null,
    answeredAt: null,
    answeredBy: null,
    answeredByName: null,
    answeredByKind: null,
    answererKind: null,
    answerChannel: null,
    jevPick: null,
    jevConfidence: null,
    jevProbabilities: null,
    jevModel: null,
    jevInputTokens: null,
    jevError: null,
    jevAgreed: null,
    jevQuestionVersion: null,
    jevFits: null,
    jevOrderFlipped: null,
    awaitingOperatorAt: input.awaitingOperatorAt ?? null,
    relayedBy: null,
    overturnedAt: null,
    overturnedBy: null,
    overturnedByName: null,
    overturnReason: null,
    replacement: null,
    filedAs: null,
    filedRef: null,
    filedRecordId: null,
    filedLabel: null,
    filedAt: null,
    closedAt: null,
    closeReason: null,
    withheldFields: [],
    createdAt: input.askedAt,
    updatedAt: input.askedAt,
  }
  const result = await questionStore(database).write('ask', {
    requestId: newRecordId(),
    question,
    audit: { action: 'ask', actorSession: null, at: input.askedAt, reason: null },
  })
  enqueueQuestionRecord(database, id)
  return result
}

// concern: question-store snapshot mutations
/** Converts port reads into the validated snapshot writes shared by both adapters. */

import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { nullableRecordIso, recordIso } from '../../../shared/record-timestamp.ts'
import { machineId } from '../record/machine-identity.ts'
import type { QuestionLiveIntent, QuestionWriteBody } from '../record/record-question-contract.ts'
import { questionStore } from './question-store.ts'
import { questionById } from './question-store-read.ts'
import { questionTextRefusal } from './question-text.ts'

type Snapshot = QuestionWriteBody['question']
const nullable = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const timestamp = (field: string, value: unknown): string => {
  try {
    return recordIso(value)
  } catch (error) {
    throw new Error(`invalid question timestamp ${field}: ${String(error)}`, { cause: error })
  }
}
const nullableTimestamp = (field: string, value: unknown): string | null => {
  try {
    return nullableRecordIso(value)
  } catch (error) {
    throw new Error(`invalid question timestamp ${field}: ${String(error)}`, { cause: error })
  }
}
const json = (value: unknown): unknown => {
  if (typeof value !== 'string') return value ?? null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export function questionSnapshotFromRow(row: Record<string, unknown>): Snapshot {
  const askedAt = timestamp('askedAt', row.asked_at)
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
    answeredAt: nullableTimestamp('answeredAt', row.answered_at),
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
    awaitingOperatorAt: nullableTimestamp('awaitingOperatorAt', row.awaiting_operator_at),
    relayedBy: nullable(row.relayed_by),
    overturnedAt: nullableTimestamp('overturnedAt', row.overturned_at),
    overturnedBy: nullable(row.overturned_by),
    overturnedByName: nullable(row.overturned_by_name),
    overturnReason: nullable(row.overturn_reason),
    replacement: nullable(row.replacement),
    filedAs: nullable(row.filed_as),
    filedRef: nullable(row.filed_ref),
    filedRecordId: nullable(row.filed_record_id),
    filedLabel: nullable(row.filed_label),
    filedAt: nullableTimestamp('filedAt', row.filed_at),
    closedAt: nullableTimestamp('closedAt', row.closed_at),
    closeReason: nullable(row.close_reason),
    withheldFields: Array.isArray(row.withheld_fields) ? row.withheld_fields.map(String) : [],
    createdAt: nullableTimestamp('createdAt', row.created_at) ?? askedAt,
    updatedAt: nullableTimestamp('updatedAt', row.updated_at) ?? askedAt,
  }
}

export async function mutateQuestion(
  database: Database,
  input: {
    id: string
    intent: QuestionLiveIntent
    at: string
    actorSession: string | null
    reason: string | null
    auditAction?: string
    changes: Partial<Snapshot>
    expectedRevision?: number
    requireOpen?: boolean
  },
) {
  const row = await questionById(database, input.id)
  if (!row) throw new Error(`question ${input.id} not found`)
  if (input.requireOpen && (row.answered_at != null || row.closed_at != null))
    return { applied: false as const }
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
      action: input.auditAction ?? input.intent,
      actorSession: input.actorSession,
      at: input.at,
      reason: input.reason,
    },
  })
  return { ...result, question: { ...current, ...input.changes } }
}

export function requireQuestionMutationApplied(
  result: { applied: boolean },
  question: Record<string, unknown>,
): void {
  if (result.applied) return
  throw new Error(`question ${String(question.number)} changed; rerun the command`)
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
  const refusal = questionTextRefusal(input.question)
  if (refusal)
    throw new Error(
      `${refusal} The question text must be a non-empty string; fix the caller that built it.`,
    )
  const id = input.id ?? newRecordId()
  let projectId = input.projectId ?? null
  if (!projectId && input.runId) {
    const run = database
      .query<{ project_record_id: string | null }, [string]>(
        'SELECT project_record_id FROM run WHERE record_id=?',
      )
      .get(input.runId)
    if (!run)
      throw new Error(
        `run ${input.runId} is not in this machine's store, so its question has no record space; rerun the command from the machine that started the run`,
      )
    if (!run.project_record_id)
      throw new Error(
        `run ${input.runId} carries no project, so its question has no record space; start the run from a registered project checkout, then retry`,
      )
    projectId = run.project_record_id
  }
  const question: Snapshot = {
    id,
    number: null,
    runId: input.runId ?? null,
    workflowKey: input.workflowKey ?? null,
    workflowTaskId: input.workflowTaskId ?? null,
    workflowCursorRecordId: input.workflowCursorRecordId ?? null,
    projectId,
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
  return result
}

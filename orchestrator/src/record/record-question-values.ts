// concern: record-question-values
/** Maps typed worker-question evidence into the hosted question columns. */

type Payload = Record<string, unknown>

import { nullableRecordDate, recordDate } from '../../../shared/record-timestamp.ts'
import { nullableNumber, nullableUuid } from './record-value-conversions.ts'

const text = (value: unknown): string | null => (value == null ? null : String(value))
const number = (value: unknown): number | null => (value == null ? null : Number(value))

export const questionValues = (
  row: Payload,
  projectId: string | null,
  workflowTaskId: string | null,
) => ({
  id: String(row.id),
  number: nullableNumber(row.number),
  spaceId: String(row.spaceId),
  runId: text(row.runId),
  workflowKey: text(row.workflowKey),
  workflowTaskId,
  workflowCursorRecordId: nullableUuid(
    row.workflowCursorRecordId,
    'question.workflowCursorRecordId',
  ),
  projectId,
  machineId: String(row.machineId),
  revision: Number(row.revision),
  lastRequestId: null,
  askedAt: recordDate(row.askedAt),
  question: String(row.question),
  options: row.options,
  recommendation: text(row.recommendation),
  why: text(row.why),
  askedVia: text(row.askedVia),
  ...typedQuestionRecordValues(row),
  answer: text(row.answer),
  answerBasis: text(row.answerBasis),
  answeredAt: nullableRecordDate(row.answeredAt),
  answeredBy: text(row.answeredBy),
  answeredByName: text(row.answeredByName),
  answererKind: text(row.answererKind),
  answerChannel: text(row.answerChannel),
  awaitingOperatorAt: nullableRecordDate(row.awaitingOperatorAt),
  relayedBy: text(row.relayedBy),
  overturnedAt: nullableRecordDate(row.overturnedAt),
  overturnedBy: text(row.overturnedBy),
  overturnedByName: text(row.overturnedByName),
  overturnReason: text(row.overturnReason),
  replacement: text(row.replacement),
  filedAs: text(row.filedAs),
  filedRef: text(row.filedRef),
  filedRecordId: text(row.filedRecordId),
  filedLabel: text(row.filedLabel),
  filedAt: nullableRecordDate(row.filedAt),
  closedAt: nullableRecordDate(row.closedAt),
  closeReason: text(row.closeReason),
  withheldFields: row.withheldFields,
  createdAt: recordDate(row.createdAt),
  updatedAt: recordDate(row.updatedAt),
})

function typedQuestionRecordValues(row: Payload) {
  return {
    kind: text(row.kind),
    typedOptions: row.typedOptions,
    criteria: row.criteria,
    levels: row.levels,
    answerValue: text(row.answerValue),
    answeredByKind: text(row.answeredByKind),
    jevPick: text(row.jevPick),
    jevConfidence: number(row.jevConfidence),
    jevProbabilities: row.jevProbabilities,
    jevModel: text(row.jevModel),
    jevInputTokens: number(row.jevInputTokens),
    jevError: text(row.jevError),
    jevAgreed: number(row.jevAgreed),
    jevQuestionVersion: number(row.jevQuestionVersion),
    jevFits: number(row.jevFits),
    jevOrderFlipped: number(row.jevOrderFlipped),
  }
}

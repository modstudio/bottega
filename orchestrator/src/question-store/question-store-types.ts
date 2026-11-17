// concern: question-store-port-types
/** Declares the question persistence boundary without choosing an adapter. */

import type {
  QuestionIntent,
  QuestionReadInput,
  QuestionWriteBody,
  QuestionWriteResult,
} from '../record/record-question-contract.ts'
import type {
  TaskFlowInboxQuestionRow,
  TaskFlowOpenSessionStageRow,
  TaskFlowTaskRulingRow,
  TaskFlowWaitingQuestionRow,
} from '../workflow/task-flow-store-types.ts'
import type { QueriedInboxQuestion } from './question-store-sqlite-reads.ts'

export type { QueriedInboxQuestion } from './question-store-sqlite-reads.ts'

type QuestionInboxRow = QueriedInboxQuestion | TaskFlowInboxQuestionRow
type QuestionWaitingRow = TaskFlowWaitingQuestionRow
type QuestionOpenSessionRow = TaskFlowOpenSessionStageRow
type QuestionRulingRow = {
  number: number
  record_id: string
  run_record_id: string | null
  run_number: number | null
  workflow_cursor_id: string | null
  workflow_key: string | null
  project: string | null
  workflow_slug: string | null
  mode_slug: string | null
  session_id: string | null
  asked_at: string
  question: string
  answer: string | null
  answer_basis: string | null
  answered_at: string | null
  answered_by: string | null
  answered_by_name: string | null
  asked_via: string | null
  answerer_kind: string | null
  answer_channel: string | null
  closed_at: string | null
  close_reason: string | null
  overturned_at: string | null
  overturned_by: string | null
  overturned_by_name: string | null
  overturn_reason: string | null
  replacement: string | null
  filed_as: string | null
  filed_ref: string | null
  filed_record_id: string | null
  filed_label: string | null
  filed_at: string | null
}
type QuestionTaskRulingRow = TaskFlowTaskRulingRow
type QuestionProjectRow = { project: string | null }
export type QuestionReadRow =
  | QuestionInboxRow
  | QuestionWaitingRow
  | QuestionOpenSessionRow
  | QuestionRulingRow
  | QuestionTaskRulingRow
  | QuestionProjectRow
  | Record<string, unknown>
export type QuestionReadResult = {
  items: QuestionReadRow[]
  cursor?: string
  more?: boolean
  reset?: boolean
}
export interface QuestionStore {
  write(intent: QuestionIntent, input: QuestionWriteBody): Promise<QuestionWriteResult>
  read(input: QuestionReadInput, projectId?: string): Promise<QuestionReadResult>
}

// concern: question-store-port-types
/** Declares the question persistence boundary without choosing an adapter. */

import type {
  QuestionIntent,
  QuestionReadInput,
  QuestionWriteBody,
  QuestionWriteResult,
} from '../record/record-question-contract.ts'
import type { QueriedInboxQuestion } from '../run/run-inbox.ts'
import type {
  TaskFlowOpenSessionStageRow,
  TaskFlowInboxQuestionRow,
  TaskFlowRulingRow,
  TaskFlowTaskRulingRow,
  TaskFlowWaitingQuestionRow,
} from '../workflow/task-flow-store-types.ts'

export type QuestionProjectRow = { project: string | null }
export type QuestionReadRow =
  | QueriedInboxQuestion
  | TaskFlowInboxQuestionRow
  | TaskFlowWaitingQuestionRow
  | TaskFlowOpenSessionStageRow
  | TaskFlowRulingRow
  | TaskFlowTaskRulingRow
  | QuestionProjectRow
export type QuestionReadResult = { items: QuestionReadRow[] }
export interface QuestionStore {
  write(intent: QuestionIntent, input: QuestionWriteBody): Promise<QuestionWriteResult>
  read(input: QuestionReadInput): Promise<QuestionReadResult>
}

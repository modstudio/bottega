// concern: workflows
/** Reads the question fact bound to an operator-ruling step. */

import type { Database } from 'bun:sqlite'
import {
  latestQuestionOnStep,
  questionsForWorkflowCursor,
} from '../question-store/question-store-read.ts'
import { type Floor, isOperatorRulingFloor, type ValidatedEvidence } from './workflow-floor.ts'
import type { QuestionEvidenceRow } from './workflow-floor-evidence.ts'
import { strandedWorkflowQuestionRemedy } from './workflow-stranded-question.ts'

export async function gatherStepQuestionEvidence(
  input: { floors: Floor[]; cursorId: string; stepOrdinal: number; stepSlug: string },
  d: Database,
  factsOf: (
    row: QuestionEvidenceRow,
  ) => Pick<NonNullable<ValidatedEvidence['stepQuestion']>, 'state' | 'answeredAt' | 'replacement'>,
): Promise<Pick<ValidatedEvidence, 'stepQuestion' | 'strandedQuestionRemedy'>> {
  if (!input.floors.some(isOperatorRulingFloor)) return {}
  const questions = await questionsForWorkflowCursor(d, input.cursorId)
  const strandedQuestion = strandedWorkflowQuestionRemedy(questions)
  return {
    ...gatherStepQuestionEvidenceFromRows(questions, input, factsOf),
    ...(strandedQuestion ? { strandedQuestionRemedy: strandedQuestion } : {}),
  }
}

export function gatherStepQuestionEvidenceFromRows(
  questions: Record<string, unknown>[],
  input: { stepOrdinal: number; stepSlug: string },
  factsOf: (
    row: QuestionEvidenceRow,
  ) => Pick<NonNullable<ValidatedEvidence['stepQuestion']>, 'state' | 'answeredAt' | 'replacement'>,
): Pick<ValidatedEvidence, 'stepQuestion'> {
  const question = latestQuestionOnStep(questions, {
    ordinal: input.stepOrdinal,
    slug: input.stepSlug,
  })
  const row = question
    ? ({
        id: Number(question.number),
        answered_at: question.answered_at as string | null,
        answerer_kind: question.answerer_kind as string | null,
        overturned_at: question.overturned_at as string | null,
        replacement: question.replacement as string | null,
        is_open: question.answered_at === null && question.closed_at === null ? 1 : 0,
      } satisfies QuestionEvidenceRow)
    : null
  if (!row) return {}
  const { state, answeredAt, replacement } = factsOf(row)
  return { stepQuestion: { id: row.id, state, answeredAt, replacement } }
}

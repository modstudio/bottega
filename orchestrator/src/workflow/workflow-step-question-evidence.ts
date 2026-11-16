// concern: workflows
/** Reads the question fact bound to an operator-ruling step. */

import type { Database } from 'bun:sqlite'
import { questionsForWorkflowCursor } from '../question-store/question-store-read.ts'
import { type Floor, isOperatorRulingFloor, type ValidatedEvidence } from './workflow-floor.ts'
import type { QuestionEvidenceRow } from './workflow-floor-evidence.ts'

export async function gatherStepQuestionEvidence(
  input: { floors: Floor[]; cursorId: string; stepOrdinal: number; stepSlug: string },
  d: Database,
  factsOf: (
    row: QuestionEvidenceRow,
  ) => Pick<NonNullable<ValidatedEvidence['stepQuestion']>, 'state' | 'answeredAt' | 'replacement'>,
): Promise<Pick<ValidatedEvidence, 'stepQuestion'>> {
  if (!input.floors.some(isOperatorRulingFloor)) return {}
  const question = (await questionsForWorkflowCursor(d, input.cursorId))
    .filter(
      (row) =>
        Number(row.workflow_step_ordinal) === input.stepOrdinal &&
        row.workflow_step_slug === input.stepSlug,
    )
    .sort((a, b) => Number(b.number) - Number(a.number))[0]
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

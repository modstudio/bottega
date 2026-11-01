// concern: workflows
/** Reads the question fact bound to an operator-ruling step. */

import type { Database } from 'bun:sqlite'
import { questionOpenSql } from '../run/question-open.ts'
import { type Floor, isOperatorRulingFloor, type ValidatedEvidence } from './workflow-floor.ts'

export type StepQuestionRow = {
  id: number
  answered_at: string | null
  answerer_kind: string | null
  overturned_at: string | null
  replacement: string | null
  is_open: number
}

export function gatherStepQuestionEvidence(
  input: { floors: Floor[]; cursorId: string; stepOrdinal: number; stepSlug: string },
  d: Database,
  factsOf: (
    row: StepQuestionRow,
  ) => Pick<NonNullable<ValidatedEvidence['stepQuestion']>, 'state' | 'answeredAt' | 'replacement'>,
): Pick<ValidatedEvidence, 'stepQuestion'> {
  if (!input.floors.some(isOperatorRulingFloor)) return {}
  const row = d
    .query<StepQuestionRow, [string, number, string]>(
      `SELECT number id,answered_at,answerer_kind,overturned_at,replacement,${questionOpenSql('question')} is_open
         FROM question
        WHERE workflow_cursor_record_id=? AND workflow_step_ordinal=? AND workflow_step_slug=?
        ORDER BY number DESC
        LIMIT 1`,
    )
    .get(input.cursorId, input.stepOrdinal, input.stepSlug)
  if (!row) return {}
  const { state, answeredAt, replacement } = factsOf(row)
  return { stepQuestion: { id: row.id, state, answeredAt, replacement } }
}

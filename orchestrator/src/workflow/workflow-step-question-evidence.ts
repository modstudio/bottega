// concern: workflows
/** Reads the question fact bound to an operator-ruling step. */

import type { Database } from 'bun:sqlite'
import { questionOpenSql } from '../run/question-open.ts'
import { isOperatorRulingFloor, type Floor, type ValidatedEvidence } from './workflow-floor.ts'
import { questionRowToFacts } from './workflow-floor-evidence.ts'

export function gatherStepQuestionEvidence(
  floors: Floor[],
  cursorId: string,
  stepOrdinal: number,
  stepSlug: string,
  d: Database,
): Pick<ValidatedEvidence, 'stepQuestion'> {
  if (!floors.some(isOperatorRulingFloor)) return {}
  const row = d
    .query<
      { id: number; answered_at: string | null; answerer_kind: string | null; is_open: number },
      [string, number, string]
    >(
      `SELECT number id,answered_at,answerer_kind,${questionOpenSql('question')} is_open
         FROM question
        WHERE workflow_cursor_record_id=? AND workflow_step_ordinal=? AND workflow_step_slug=?
        ORDER BY number DESC
        LIMIT 1`,
    )
    .get(cursorId, stepOrdinal, stepSlug)
  if (!row) return {}
  const facts = questionRowToFacts(row)
  return { stepQuestion: { id: row.id, state: facts.state, answeredAt: facts.answeredAt } }
}

// concern: workflows
/** Reads the question fact bound to an operator-ruling step. */

import type { Database } from 'bun:sqlite'
import type { Floor, ValidatedEvidence } from './workflow-floor.ts'

export function gatherStepQuestionEvidence(
  floors: Floor[] | undefined,
  cursorId: string,
  stepOrdinal: number,
  stepSlug: string,
  d: Database,
): Pick<ValidatedEvidence, 'stepQuestion'> {
  if (!floors?.some((floor) => floor.kind === 'ruling' && floor.operatorRuling)) return {}
  const row = d
    .query<
      { id: number; answered_at: string | null; answerer_kind: string | null },
      [string, number, string]
    >(
      `SELECT number id,answered_at,answerer_kind
         FROM question
        WHERE workflow_cursor_record_id=? AND workflow_step_ordinal=? AND workflow_step_slug=?
        ORDER BY CASE WHEN answered_at IS NOT NULL AND answerer_kind='operator' THEN 0 ELSE 1 END,
                 number DESC
        LIMIT 1`,
    )
    .get(cursorId, stepOrdinal, stepSlug)
  if (!row) return {}
  return {
    stepQuestion: {
      id: row.id,
      answered: row.answered_at !== null,
      answeredByOperator: row.answered_at !== null && row.answerer_kind === 'operator',
    },
  }
}

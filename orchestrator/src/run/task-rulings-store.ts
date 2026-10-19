// concern: task-rulings-store
/** Loads task ruling rows for a new dispatch. Must not know prompt assembly or run claiming. */

import { db } from '../database/db.ts'
import {
  selectTaskRulings,
  TASK_RULINGS_MAX_COUNT,
  type TaskRulingRow,
  type TaskRulingsSelection,
} from './task-rulings.ts'

export function taskRulingsForDispatch(input: {
  resume: boolean
  project: string | null
  launchKey: string | null
}): TaskRulingsSelection {
  if (input.resume || input.project === null || input.launchKey === null) {
    return { rulings: [], omitted: 0 }
  }
  const rows = db()
    .query(
      `WITH raw_candidates AS (
         SELECT q.id question_id, root.record_id run_record_id, NULL workflow_cursor_id,
                q.question, q.answer, q.answer_basis, q.answered_at,
                q.answerer_kind, q.overturned_at, q.replacement,
                COALESCE(q.overturned_at,q.answered_at) effective_at
           FROM question q
           JOIN run owner ON owner.record_id=q.run_record_id
           JOIN run root ON root.record_id=COALESCE(owner.parent_run_record_id,owner.record_id)
          WHERE root.project_record_id=(SELECT record_id FROM project WHERE name=?)
            AND root.launch_key=?
            AND q.answered_at IS NOT NULL
            AND NOT (q.overturned_at IS NOT NULL AND q.replacement IS NULL)
         UNION ALL
         SELECT q.id question_id, NULL run_record_id, q.workflow_cursor_id,
                q.question, q.answer, q.answer_basis, q.answered_at,
                q.answerer_kind, q.overturned_at, q.replacement,
                COALESCE(q.overturned_at,q.answered_at) effective_at
           FROM question q
           JOIN workflow_cursor c ON c.id=q.workflow_cursor_id
          WHERE c.project_record_id=(SELECT record_id FROM project WHERE name=?)
            AND q.workflow_key=?
            AND q.answered_at IS NOT NULL
            AND NOT (q.overturned_at IS NOT NULL AND q.replacement IS NULL)
       ), candidates AS (
         SELECT *, COUNT(*) OVER () candidate_count FROM raw_candidates
       )
       SELECT question_id,run_record_id,workflow_cursor_id,question,answer,answer_basis,answered_at,answerer_kind,
              overturned_at,replacement,candidate_count
         FROM candidates
        ORDER BY effective_at DESC, question_id DESC
        LIMIT ?`,
    )
    .all(
      input.project,
      input.launchKey,
      input.project,
      input.launchKey,
      TASK_RULINGS_MAX_COUNT + 1,
    ) as TaskRulingRow[]
  const candidateCount = rows[0]?.candidate_count ?? 0
  const capped = rows.slice(0, TASK_RULINGS_MAX_COUNT)
  return selectTaskRulings(capped, Math.max(0, candidateCount - capped.length))
}

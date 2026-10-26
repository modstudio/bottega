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
  taskRecordId: string | null
}): TaskRulingsSelection {
  if (input.resume || input.project === null || input.taskRecordId === null) {
    return { rulings: [], omitted: 0 }
  }
  const rows = db()
    .query(
      `WITH raw_candidates AS (
         SELECT q.number question_id,q.record_id question_record_id,root.record_id run_record_id,NULL workflow_cursor_record_id,
                q.question, q.answer, q.answer_basis, q.answered_at,
                q.answerer_kind, q.answered_by_name, q.overturned_at, q.overturned_by_name, q.replacement,
                COALESCE(q.overturned_at,q.answered_at) effective_at
           FROM question q
           JOIN run owner ON owner.record_id=q.run_record_id
           JOIN run root ON root.record_id=COALESCE(owner.parent_run_record_id,owner.record_id)
          WHERE root.project_record_id=(SELECT record_id FROM project WHERE name=?)
            AND root.task_record_id=?
            AND q.answered_at IS NOT NULL
            AND NOT (q.overturned_at IS NOT NULL AND q.replacement IS NULL)
         UNION ALL
         SELECT q.number question_id,q.record_id question_record_id,NULL run_record_id,q.workflow_cursor_record_id,
                q.question, q.answer, q.answer_basis, q.answered_at,
                q.answerer_kind, q.answered_by_name, q.overturned_at, q.overturned_by_name, q.replacement,
                COALESCE(q.overturned_at,q.answered_at) effective_at
           FROM question q
           JOIN workflow_cursor c ON c.record_id=q.workflow_cursor_record_id
          WHERE c.project_record_id=(SELECT record_id FROM project WHERE name=?)
            AND q.workflow_task_record_id=?
            AND q.answered_at IS NOT NULL
            AND NOT (q.overturned_at IS NOT NULL AND q.replacement IS NULL)
       ), candidates AS (
         SELECT *, COUNT(*) OVER () candidate_count FROM raw_candidates
       )
       SELECT question_id,question_record_id,run_record_id,workflow_cursor_record_id,question,answer,answer_basis,answered_at,answerer_kind,
              answered_by_name,overturned_at,overturned_by_name,replacement,candidate_count
         FROM candidates
        ORDER BY effective_at DESC, question_id DESC
        LIMIT ?`,
    )
    .all(
      input.project,
      input.taskRecordId,
      input.project,
      input.taskRecordId,
      TASK_RULINGS_MAX_COUNT + 1,
    ) as TaskRulingRow[]
  const candidateCount = rows[0]?.candidate_count ?? 0
  const capped = rows.slice(0, TASK_RULINGS_MAX_COUNT)
  return selectTaskRulings(capped, Math.max(0, candidateCount - capped.length))
}

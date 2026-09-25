// concern: task-rulings-store
/** Loads task ruling rows for a new dispatch. Must not know prompt assembly or run claiming. */

import { db } from '../database/db.ts'
import { selectTaskRulings, type TaskRulingRow, type TaskRulingsSelection } from './task-rulings.ts'

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
      `SELECT q.id question_id, root.id run_id, root.repo project,
              root.launch_key, q.question, q.answer, q.answered_at,
              q.answerer_kind, q.overturned_at, q.replacement
         FROM question q
         JOIN run owner ON owner.id=q.run_id
         JOIN run root ON root.id=COALESCE(owner.parent_run_id,owner.id)
        WHERE q.answered_at IS NOT NULL`,
    )
    .all() as TaskRulingRow[]
  return selectTaskRulings(rows, input.project, input.launchKey)
}

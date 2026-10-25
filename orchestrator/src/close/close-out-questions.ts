// concern: close-out-questions
/** Closes unanswered questions when close-out observes an already-terminal chain. */

import { db, writeTransaction } from '../database/db.ts'
import { closeRunChainQuestions, QUESTION_CLOSE_CHAIN_TERMINAL } from '../run/question-close.ts'
import { TERMINAL_RUN_STATUS_SET } from '../run/run-status.ts'

export function closeTerminalChainQuestions(rootId: string, dryRun: boolean): void {
  if (dryRun) return
  const turns = db()
    .query<{ status: string }, [string, string]>(
      'SELECT status FROM run WHERE record_id=? OR parent_run_record_id=?',
    )
    .all(rootId, rootId)
  if (turns.length === 0 || turns.some((turn) => !TERMINAL_RUN_STATUS_SET.has(turn.status))) return
  writeTransaction(() => {
    closeRunChainQuestions(db(), rootId, QUESTION_CLOSE_CHAIN_TERMINAL)
  })
}

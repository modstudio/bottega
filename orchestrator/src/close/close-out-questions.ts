// concern: close-out-questions
/** Closes unanswered questions when close-out observes an already-terminal chain. */

import { db, writeTransaction } from '../database/db.ts'
import { closeRunChainQuestions, QUESTION_CLOSE_CHAIN_TERMINAL } from '../run/question-close.ts'

const TERMINAL = new Set(['ok', 'failed', 'stale', 'stopped'])

export function closeTerminalChainQuestions(rootId: number, dryRun: boolean): void {
  if (dryRun) return
  const turns = db()
    .query<{ status: string }, [number, number]>(
      'SELECT status FROM run WHERE id=? OR parent_run_id=?',
    )
    .all(rootId, rootId)
  if (turns.length === 0 || turns.some((turn) => !TERMINAL.has(turn.status))) return
  writeTransaction(() => {
    closeRunChainQuestions(db(), rootId, QUESTION_CLOSE_CHAIN_TERMINAL)
  })
}

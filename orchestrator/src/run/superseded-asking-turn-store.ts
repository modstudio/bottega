// concern: superseded asking turn store
/** Reads and closes superseded asking turns without deciding chain policy. */

import type { Database } from 'bun:sqlite'
import { machineId } from '../record/machine-identity.ts'
import { enqueueRunRecord } from './run-outbox.ts'
import { type ChainTurnState, supersededAskingTurns } from './superseded-asking-turn.ts'

export function supersededAskingTurnDecisions(
  database: Database,
  rootId?: string,
): ReturnType<typeof supersededAskingTurns> {
  const where = rootId ? 'WHERE parent_run_record_id = ?' : 'WHERE parent_run_record_id IS NOT NULL'
  const rows = database
    .query(
      `SELECT record_id AS recordId, parent_run_record_id AS rootId, number, turn, status
         FROM run ${where}
        ORDER BY parent_run_record_id, turn, number`,
    )
    .all(...(rootId ? [rootId] : [])) as ChainTurnState[]
  return supersededAskingTurns(rows)
}

/** Close asking continuation turns that a later turn in the same chain superseded. */
export function reconcileSupersededAskingTurns(
  database: Database,
  finishedAt: string,
  rootId?: string,
): number {
  const decisions = supersededAskingTurnDecisions(database, rootId)
  const update = database.query(
    `UPDATE run SET status='stale', failure_kind='abandoned', error=?
      WHERE record_id=? AND status='asking'`,
  )
  let changed = 0
  for (const decision of decisions) {
    const result = update.run(`superseded by run ${decision.supersededByNumber}`, decision.recordId)
    if (result.changes !== 1) continue
    enqueueRunRecord(database, decision.recordId, machineId(), finishedAt)
    changed++
  }
  return changed
}

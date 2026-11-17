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

/** Asking rows whose latest chain mutation is an architect abandon lost that verdict. */
export function overwrittenAbandonedAskingTurnIds(database: Database): string[] {
  return (
    database
      .query(
        `SELECT asking.record_id
           FROM run asking
          WHERE asking.status='asking'
            AND (
              SELECT audit.action
                FROM run_mutation_audit audit
               WHERE audit.root_run_record_id = COALESCE(asking.parent_run_record_id, asking.record_id)
               ORDER BY audit.at DESC, audit.rowid DESC
               LIMIT 1
            ) = 'abandon'`,
      )
      .all() as { record_id: string }[]
  ).map(({ record_id }) => record_id)
}

/** Restore an architect abandon verdict overwritten by a worker's late terminal write. */
export function reconcileOverwrittenAbandonedAskingTurns(
  database: Database,
  finishedAt: string,
): string[] {
  const candidates = overwrittenAbandonedAskingTurnIds(database)
  const update = database.query(
    "UPDATE run SET status='stale', failure_kind='abandoned' WHERE record_id=? AND status='asking'",
  )
  const repaired: string[] = []
  for (const recordId of candidates) {
    if (update.run(recordId).changes !== 1) continue
    enqueueRunRecord(database, recordId, machineId(), finishedAt)
    repaired.push(recordId)
  }
  return repaired
}

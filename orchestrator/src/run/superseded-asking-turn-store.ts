// concern: superseded asking turn store
/** Reads asking-turn repair facts. Audit is the only evidence for verdicts overwritten before the write guard existed. */

import type { Database } from 'bun:sqlite'
import { machineId } from '../record/machine-identity.ts'
import { writeSupersededAskingTurn } from '../route/failover.ts'
import { architectAbandonError, writeAskingRunAbandoned } from './asking-run-lifecycle-store.ts'
import { auditRunMutation, runMutationAuthority } from './run-authority.ts'
import { enqueueRunRecord } from './run-outbox.ts'
import {
  type AskingTurnAuditRow,
  type ChainTurnState,
  overwrittenAbandonedAskingTurns,
  supersededAskingTurns,
} from './superseded-asking-turn.ts'

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
  decisions: ReturnType<typeof supersededAskingTurns>,
  finishedAt: string,
): number {
  let changed = 0
  for (const decision of decisions) {
    const reason = `superseded by run ${decision.supersededByNumber}`
    if (!writeSupersededAskingTurn(database, decision.recordId)) continue
    auditRunMutation(runMutationAuthority(database, decision.recordId), 'reap', reason, database)
    enqueueRunRecord(database, decision.recordId, machineId(), finishedAt)
    changed++
  }
  return changed
}

/** Asking rows whose latest chain mutation is an architect abandon lost that verdict. */
export function overwrittenAbandonedAskingTurnDecisions(
  database: Database,
): ReturnType<typeof overwrittenAbandonedAskingTurns> {
  const rows = database
    .query(
      `SELECT asking.record_id AS recordId, audit.action, audit.at, audit.rowid AS rowId, audit.reason
         FROM run asking
         JOIN run_mutation_audit audit
           ON audit.root_run_record_id=COALESCE(asking.parent_run_record_id, asking.record_id)
        WHERE asking.status='asking'
        ORDER BY asking.record_id, audit.at DESC, audit.rowid DESC`,
    )
    .all() as AskingTurnAuditRow[]
  return overwrittenAbandonedAskingTurns(rows)
}

/** Restore an architect abandon verdict overwritten by a worker's late terminal write. */
export function reconcileOverwrittenAbandonedAskingTurns(
  database: Database,
  candidates: ReturnType<typeof overwrittenAbandonedAskingTurns>,
  finishedAt: string,
): string[] {
  const repaired: string[] = []
  for (const candidate of candidates) {
    const error = architectAbandonError(candidate.reason)
    if (!writeAskingRunAbandoned(database, candidate.recordId, error)) continue
    auditRunMutation(
      runMutationAuthority(database, candidate.recordId),
      'reap',
      'architect abandon verdict restored after late terminal write',
      database,
    )
    enqueueRunRecord(database, candidate.recordId, machineId(), finishedAt)
    repaired.push(candidate.recordId)
  }
  return repaired
}

// concern: close-out lease admission
/** Adapts non-blocking close-out lease refusal to the close-out result vocabulary. */

import { db } from '../database/db.ts'
import { withRunCloseOutLease } from '../run/run-lease.ts'

type CloseOutLeaseRefusal = {
  runId: string
  worktree: string | null
  outcome: 'held'
  detail: string
}

/** Run an action under its close-out lease, or name the owner that kept it out. */
export function withCloseOutLease<T>(
  runId: string,
  alreadyHeld: boolean,
  action: () => T,
): T | CloseOutLeaseRefusal {
  if (alreadyHeld) return action()
  let acquisitionFailure: unknown
  try {
    return withRunCloseOutLease(
      runId,
      (cause) => {
        acquisitionFailure = cause
      },
      action,
    )
  } catch (cause) {
    if (cause !== acquisitionFailure) throw cause
    const row = db()
      .query<{ root_record_id: string; worktree: string | null }, [string]>(
        `SELECT COALESCE(parent_run_record_id,record_id) root_record_id,worktree
           FROM run WHERE record_id=?`,
      )
      .get(runId)
    if (!row) throw new Error(`no run ${runId}`)
    return {
      runId: row.root_record_id,
      worktree: row.worktree,
      outcome: 'held',
      detail: `close-out lease for run ${runId} is already held; close-out skipped`,
    }
  }
}

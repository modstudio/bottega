// concern: unjudged expiry
/** Reads the owed-judgment ledger and records an expired row locally and for hosted sync. */
import { newRecordId } from '../../../shared/record/schema.ts'
import { db, writeTransaction } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'
import { enqueueRunRecord } from '../run/run-outbox.ts'
import { UNSCORED_WHERE } from './evidence-query.ts'

export type UnjudgedRun = {
  id: number
  session_id: string | null
  session_last_seen: string | null
  run_last_activity: string
}

export const UNJUDGED_EXCLUSION_REASON = 'unjudged: owner gone'

/** Exclude one run from evidence and enqueue the changed hosted record atomically. */
export function settleRunEvidence(runId: number, reason: string, changedAt: string): void {
  writeTransaction(() => {
    db().query('UPDATE run SET evidence_excluded=? WHERE id=?').run(reason, runId)
    enqueueRunRecord(db(), runId, machineId(), changedAt)
  })
}

type UnjudgedExpiryDecision = (facts: {
  ownerSessionId: string | null
  ownerLastSeenAt: number | null
  runLastActivityAt: number
  now: number
  windowMs: number
}) => boolean

export function unjudgedRuns(projectName: string | null): UnjudgedRun[] {
  return db()
    .query(
      `SELECT r.id, r.session_id, seen.last_seen AS session_last_seen,
              (SELECT COALESCE(turn.last_event_at, turn.started_at)
                 FROM run turn
                WHERE turn.id=r.id OR turn.parent_run_id=r.id
                ORDER BY turn.turn DESC, turn.id DESC LIMIT 1) AS run_last_activity
         FROM run r
         LEFT JOIN score s ON s.run_id=r.id
         LEFT JOIN session_seen seen ON seen.session_id=r.session_id
         LEFT JOIN project ON project.id=r.project_id
        WHERE ${UNSCORED_WHERE}
          AND (? IS NULL OR COALESCE(r.repo, project.name)=?)
        ORDER BY r.id`,
    )
    .all(projectName, projectName) as UnjudgedRun[]
}

/** Exclude one still-unscored row and enqueue the changed run in one transaction. */
export function expireUnjudgedRun(
  row: UnjudgedRun,
  shouldExpire: UnjudgedExpiryDecision,
  windowMs: number,
): boolean {
  let expired = false
  writeTransaction(() => {
    const fresh = db()
      .query(
        `SELECT r.id, r.session_id, seen.last_seen AS session_last_seen,
                (SELECT COALESCE(turn.last_event_at, turn.started_at)
                   FROM run turn
                  WHERE turn.id=r.id OR turn.parent_run_id=r.id
                  ORDER BY turn.turn DESC, turn.id DESC LIMIT 1) AS run_last_activity
           FROM run r
           LEFT JOIN score s ON s.run_id=r.id
           LEFT JOIN session_seen seen ON seen.session_id=r.session_id
          WHERE r.id=? AND ${UNSCORED_WHERE}`,
      )
      .get(row.id) as UnjudgedRun | null
    if (
      !fresh ||
      !shouldExpire({
        ownerSessionId: fresh.session_id,
        ownerLastSeenAt:
          fresh.session_last_seen === null ? null : Date.parse(fresh.session_last_seen),
        runLastActivityAt: Date.parse(fresh.run_last_activity),
        now: Date.now(),
        windowMs,
      })
    ) {
      return
    }
    const recordId =
      db()
        .query<{ record_id: string | null }, [number]>('SELECT record_id FROM run WHERE id=?')
        .get(row.id)?.record_id ?? newRecordId()
    db()
      .query('UPDATE run SET evidence_excluded=?, record_id=? WHERE id=?')
      .run(UNJUDGED_EXCLUSION_REASON, recordId, row.id)
    enqueueRunRecord(db(), row.id, machineId(), fresh.run_last_activity)
    expired = true
  })
  return expired
}

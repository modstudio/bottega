// concern: unjudged expiry
/** Reads the owed-judgment ledger and records an expired row locally and for hosted sync. */
import { newRecordId } from '../../../shared/record/schema.ts'
import { gatherOwnerActivity } from '../cleanup/owner-activity.ts'
import { db, writeTransaction } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'
import { enqueueRunRecord } from '../run/run-outbox.ts'
import { UNSCORED_WHERE } from './evidence-query.ts'

export type UnjudgedRun = {
  record_id: string
  session_id: string | null
  session_last_seen: string | null
  run_last_activity: string
  job: string
  label: string | null
  coordinator_run: boolean
}

export const UNJUDGED_EXCLUSION_REASON = 'unjudged: owner gone'

/** Exclude one run from evidence and enqueue the changed hosted record atomically. */
export function settleRunEvidence(runId: string, reason: string, changedAt: string): void {
  writeTransaction(() => {
    db().query('UPDATE run SET evidence_excluded=? WHERE record_id=?').run(reason, runId)
    enqueueRunRecord(db(), runId, machineId(), changedAt)
  })
}

type UnjudgedExpiryDecision = (facts: {
  ownerSessionId: string | null
  ownerLastSeenAt: number | null
  runLastActivityAt: number
  coordinatorRun: boolean
  now: number
  windowMs: number
}) => boolean

export function unjudgedRuns(projectName: string | null): UnjudgedRun[] {
  const database = db()
  const rows = database
    .query(
      `SELECT r.record_id, r.session_id, r.job, r.label, r.started_at AS run_last_activity,
              NULL AS session_last_seen
         FROM run r
         LEFT JOIN score s ON s.run_record_id=r.record_id
         LEFT JOIN project ON project.record_id=r.project_record_id
        WHERE ${UNSCORED_WHERE}
          AND (? IS NULL OR project.name=?)
        ORDER BY r.number`,
    )
    .all(projectName, projectName) as UnjudgedRun[]
  return rows.map((row) => {
    const activity = gatherOwnerActivity(database, {
      ownerSessionId: row.session_id,
      runRecordId: row.record_id,
      fallbackActivityAt: row.run_last_activity,
    })
    return {
      ...row,
      session_last_seen:
        activity.ownerLastSeenAt === null ? null : new Date(activity.ownerLastSeenAt).toISOString(),
      run_last_activity: new Date(activity.runLastActivityAt).toISOString(),
      coordinator_run: activity.coordinatorRun,
    }
  })
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
        `SELECT r.record_id, r.session_id, r.job, r.label, r.started_at AS run_last_activity,
                NULL AS session_last_seen
           FROM run r
           LEFT JOIN score s ON s.run_record_id=r.record_id
          WHERE r.record_id=? AND ${UNSCORED_WHERE}`,
      )
      .get(row.record_id) as UnjudgedRun | null
    const activity = fresh
      ? gatherOwnerActivity(db(), {
          ownerSessionId: fresh.session_id,
          runRecordId: fresh.record_id,
          fallbackActivityAt: fresh.run_last_activity,
        })
      : null
    if (
      !fresh ||
      !activity ||
      !shouldExpire({
        ...activity,
        now: Date.now(),
        windowMs,
      })
    ) {
      return
    }
    const recordId =
      db()
        .query<{ record_id: string | null }, [string]>(
          'SELECT record_id FROM run WHERE record_id=?',
        )
        .get(row.record_id)?.record_id ?? newRecordId()
    db()
      .query('UPDATE run SET evidence_excluded=?, record_id=? WHERE record_id=?')
      .run(UNJUDGED_EXCLUSION_REASON, recordId, row.record_id)
    enqueueRunRecord(db(), row.record_id, machineId(), new Date(activity.runLastActivityAt).toISOString())
    expired = true
  })
  return expired
}

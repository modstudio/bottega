// concern: release-ledger
/** Owns atomic release ledger writes and their hosted-record outbox snapshots. */

import type { Database } from 'bun:sqlite'
import { userInfo } from 'node:os'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { nowIso, sessionId, writeTransaction } from '../database/db.ts'
import { enqueueReleaseRecord } from './release-outbox.ts'
export function startReleaseLedgerEntry(
  database: Database,
  input: {
    project: string
    rung: string
    candidate: string
    live: string | null
    rollback: boolean
    reason: string | null
    trunk: string
    trunkTip: string
    commitsBehindTrunk: number
    behindTrunkReason: string | null
  },
): number {
  return writeTransaction(() => {
    const row = database
      .query<{ id: number }, (string | number | null)[]>(
        `INSERT INTO release_ledger
       (record_id,project,project_record_id,rung,candidate_commit,live_commit_before,rollback,rollback_reason,trunk,trunk_tip,commits_behind_trunk,behind_trunk_reason,actor,session_id,started_at)
       VALUES (?,?,(SELECT record_id FROM project WHERE name=?),?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      )
      .get(
        newRecordId(),
        input.project,
        input.project,
        input.rung,
        input.candidate,
        input.live,
        input.rollback ? 1 : 0,
        input.reason,
        input.trunk,
        input.trunkTip,
        input.commitsBehindTrunk,
        input.behindTrunkReason,
        userInfo().username,
        sessionId(),
        nowIso(),
      )
    if (!row)
      throw new Error(
        `release ledger entry was not inserted; run ${PLATFORM_SLUG} machine migrate, then retry`,
      )
    enqueueReleaseRecord(database, row.id)
    return row.id
  }, database)
}

export function finishReleaseLedgerEntry(
  database: Database,
  id: number,
  result: { exitCode: number; output: string },
  outputTail: string,
  after: string | null,
  matches: boolean | null,
  warning: string | null,
): void {
  writeTransaction(() => {
    database
      .query(
        `UPDATE release_ledger SET finished_at=?,exit_code=?,output_tail=?,live_commit_after=?,live_matches_candidate=?,warning=? WHERE id=?`,
      )
      .run(
        nowIso(),
        result.exitCode,
        outputTail,
        after,
        matches === null ? null : matches ? 1 : 0,
        warning,
        id,
      )
    enqueueReleaseRecord(database, id)
  }, database)
}

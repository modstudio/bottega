// concern: release-outbox
/** Knows how local release ledger rows become hosted-record mutations. Must not know Postgres. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { nowIso } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'

import { stringifyOutboxPayload } from '../record/outbox-sanitize.ts'

type ReleaseRow = Record<string, unknown> & { record_id: string }

export function enqueueReleaseRecord(database: Database, releaseRecordId: string): void {
  const row = database
    .query<ReleaseRow, [string]>(
      `SELECT release_ledger.*, project.record_id AS project_record_id
       FROM release_ledger LEFT JOIN project ON project.record_id=release_ledger.project_record_id
       WHERE release_ledger.record_id=?`,
    )
    .get(releaseRecordId)
  if (!row) throw new Error(`release ${releaseRecordId} does not exist and cannot be enqueued`)
  const at = nowIso()
  const payload = stringifyOutboxPayload('release', {
      id: row.record_id,
      spaceId: PLATFORM_SPACE_ID,
      projectId: row.project_record_id,
      projectName: row.project,
      machineId: machineId(),
      localId: null,
      rung: row.rung,
      candidateCommit: row.candidate_commit,
      trunk: row.trunk,
      trunkTip: row.trunk_tip,
      commitsBehindTrunk: row.commits_behind_trunk,
      behindTrunkReason: row.behind_trunk_reason,
      liveCommitBefore: row.live_commit_before,
      liveCommitAfter: row.live_commit_after,
      rollback: Boolean(row.rollback),
      rollbackReason: row.rollback_reason,
      actor: row.actor,
      sessionId: row.session_id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      exitCode: row.exit_code,
      liveMatchesCandidate:
        row.live_matches_candidate == null ? null : Boolean(row.live_matches_candidate),
      warning: row.warning,
      createdAt: row.started_at,
      updatedAt: at,
    })
  const pending = database
    .query<{ id: number }, [string]>(
      `SELECT id FROM outbox
       WHERE kind='release' AND row_id=? AND synced_at IS NULL
         AND quarantined_at IS NULL AND retired_at IS NULL
       ORDER BY id LIMIT 1`,
    )
    .get(row.record_id)
  if (pending) {
    database
      .query('UPDATE outbox SET payload=?,created_at=?,attempts=0,last_error=NULL WHERE id=?')
      .run(payload, at, pending.id)
    return
  }
  database
    .query(
      "INSERT INTO outbox (record_id,kind,row_id,payload,created_at) VALUES (?,'release',?,?,?)",
    )
    .run(newRecordId(), row.record_id, payload, at)
}

export function backfillReleaseRecords(database: Database): { enqueued: number } {
  const releases = database
    .query<{ record_id: string }, []>(
      `SELECT record_id FROM release_ledger WHERE NOT EXISTS (
         SELECT 1 FROM outbox WHERE kind='release' AND row_id=release_ledger.record_id
       ) ORDER BY started_at,record_id`,
    )
    .all()
  for (const row of releases) enqueueReleaseRecord(database, row.record_id)
  return { enqueued: releases.length }
}

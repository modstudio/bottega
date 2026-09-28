// concern: score-outbox
/** Knows how a local verdict becomes an ordered hosted-record mutation. Must not know Postgres. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'
import { stringifyOutboxPayload } from '../record/outbox-sanitize.ts'
import type { VerdictPayload } from '../verdict/verdict-payload.ts'
import { VERDICT_PAYLOAD_COLUMNS } from '../verdict/verdict-payload.ts'

export const SCORE_RECORD_PAYLOAD_COLUMNS = VERDICT_PAYLOAD_COLUMNS
export const SCORE_RECORD_PAYLOAD_CONTRACT = {
  columns: SCORE_RECORD_PAYLOAD_COLUMNS,
  laterAdded: { projectName: null, withheldFields: null },
} as const

type LocalScore = {
  record_id: string | null
  local_id: number
  project_name: string | null
  delivery: VerdictPayload['delivery']
  quality: VerdictPayload['quality']
  fidelity: VerdictPayload['fidelity']
  note: string | null
  scored_at: string
  scored_by: string
  reproduced: VerdictPayload['reproduced']
  coverage: VerdictPayload['coverage']
  limits: VerdictPayload['limits']
  overlap: VerdictPayload['overlap']
}

export function buildScoreRecordPayload(
  row: LocalScore & { record_id: string },
  machineId: string,
): VerdictPayload {
  return {
    id: row.record_id,
    spaceId: PLATFORM_SPACE_ID,
    projectName: row.project_name,
    machineId,
    localId: row.local_id,
    delivery: row.delivery,
    quality: row.quality,
    fidelity: row.fidelity,
    note: row.note,
    scoredAt: row.scored_at,
    scoredBy: row.scored_by,
    reproduced: row.reproduced,
    coverage: row.coverage,
    limits: row.limits,
    overlap: row.overlap,
    updatedAt: row.scored_at,
  }
}

/** Returns false when the run has no hosted-record identity and its score remains local-only. */
export function enqueueScoreRecord(database: Database, runId: number, machineId: string): boolean {
  const row = database
    .query<LocalScore, [number]>(
      `SELECT r.record_id, r.id AS local_id, project.name AS project_name,
              s.delivery, s.quality, s.fidelity,
              s.note, s.scored_at, s.scored_by,
              lens.reproduced, lens.coverage, lens.limits, lens.overlap
         FROM score s JOIN run r ON r.id=s.run_id
         LEFT JOIN project ON project.id=r.project_id
         LEFT JOIN review_lens lens ON lens.run_id=r.id
        WHERE s.run_id=?`,
    )
    .get(runId)
  if (!row) throw new Error(`run ${runId} has no score and cannot be enqueued`)
  if (row.record_id === null) return false
  const payload = stringifyOutboxPayload(
    'score',
    buildScoreRecordPayload({ ...row, record_id: row.record_id }, machineId),
  )
  const pending = database
    .query<{ id: number }, [string]>(
      `SELECT id FROM outbox
        WHERE kind='score' AND record_id=? AND synced_at IS NULL
          AND quarantined_at IS NULL AND retired_at IS NULL
        ORDER BY id LIMIT 1`,
    )
    .get(row.record_id)
  if (pending) {
    database
      .query(
        `UPDATE outbox
            SET payload=?, created_at=?, attempts=0, last_error=NULL
          WHERE id=?`,
      )
      .run(payload, row.scored_at, pending.id)
  } else {
    database
      .query(
        `INSERT INTO outbox (kind, record_id, payload, created_at)
         VALUES ('score', ?, ?, ?)`,
      )
      .run(row.record_id, payload, row.scored_at)
  }
  return true
}

export function backfillScoreRecords(database: Database, machineId: string): number {
  const rows = database
    .query<{ run_id: number }, []>(
      `SELECT s.run_id
         FROM score s JOIN run r ON r.id=s.run_id
        WHERE r.record_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM outbox o WHERE o.kind='score' AND o.record_id=r.record_id
          )
        ORDER BY s.run_id`,
    )
    .all()
  for (const row of rows) enqueueScoreRecord(database, row.run_id, machineId)
  return rows.length
}

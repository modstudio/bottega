// concern: outbox-score-supersession
/** Retires quarantined score mutations once a newer verdict makes them stale. */
import type { Database } from 'bun:sqlite'
import { nowIso } from '../database/db.ts'
import { retireQuarantinedOutboxRowIfEligible } from './outbox-quarantine.ts'
import { QUARANTINED_UNRETIRED_OUTBOX_PREDICATE_SQL } from './outbox-read.ts'

export type QuarantinedScoreRow = {
  id: number
  rowId: string
  scoredAt: string
}

export type OtherScoreRow = QuarantinedScoreRow & {
  quarantined: boolean
  retired: boolean
}

/** Names the newest score row that safely supersedes a quarantined score mutation. */
export function supersedingScoreOutboxRow(
  quarantined: QuarantinedScoreRow,
  others: readonly OtherScoreRow[],
): number | null {
  let superseding: OtherScoreRow | null = null
  for (const row of others) {
    if (
      row.rowId === quarantined.rowId &&
      !row.retired &&
      !row.quarantined &&
      (row.scoredAt > quarantined.scoredAt ||
        (row.scoredAt === quarantined.scoredAt && row.id > quarantined.id)) &&
      (superseding === null ||
        row.scoredAt > superseding.scoredAt ||
        (row.scoredAt === superseding.scoredAt && row.id > superseding.id))
    ) {
      superseding = row
    }
  }
  return superseding?.id ?? null
}

type StoredScoreRow = {
  id: number
  row_id: string
  payload: string
  quarantined_at: string | null
  retired_at: string | null
}

export const QUARANTINED_SCORE_ROWS_SQL = `SELECT id,row_id,payload,quarantined_at,retired_at
  FROM outbox
 WHERE +kind='score' AND ${QUARANTINED_UNRETIRED_OUTBOX_PREDICATE_SQL}
 ORDER BY id`

function scoredAt(payload: string): string | null {
  try {
    const parsed: unknown = JSON.parse(payload)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const value = (parsed as Record<string, unknown>).scoredAt
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

/** Applies score supersession through the ordinary audited quarantine retirement path. */
export function retireSupersededQuarantinedScoreRows(database: Database, at = nowIso()): number {
  const quarantined = database.query<StoredScoreRow, []>(QUARANTINED_SCORE_ROWS_SQL).all()
  let retired = 0
  for (const row of quarantined) {
    const quarantinedScoredAt = scoredAt(row.payload)
    if (quarantinedScoredAt === null) continue
    const related = database
      .query<StoredScoreRow, [string]>(
        `SELECT id,row_id,payload,quarantined_at,retired_at
           FROM outbox INDEXED BY outbox_row_history
          WHERE kind='score'
            AND row_id=?
          ORDER BY id`,
      )
      .all(row.row_id)
    const supersedingId = supersedingScoreOutboxRow(
      { id: row.id, rowId: row.row_id, scoredAt: quarantinedScoredAt },
      related.flatMap((candidate) => {
        const candidateScoredAt = scoredAt(candidate.payload)
        return candidateScoredAt === null
          ? []
          : [
              {
                id: candidate.id,
                rowId: candidate.row_id,
                scoredAt: candidateScoredAt,
                quarantined: candidate.quarantined_at !== null,
                retired: candidate.retired_at !== null,
              },
            ]
      }),
    )
    if (supersedingId === null) continue
    if (
      retireQuarantinedOutboxRowIfEligible(
        row.id,
        `superseded by score outbox row ${supersedingId}`,
        database,
        at,
        null,
      )
    )
      retired += 1
  }
  return retired
}

// concern: outbox-score-supersession
/** Retires quarantined score mutations once a newer verdict makes them stale. */
import type { Database } from 'bun:sqlite'
import { nowIso } from '../database/db.ts'
import { retireOutboxRow } from './outbox-quarantine.ts'

export type QuarantinedScoreRow = {
  id: number
  scoredAt: string
}

export type OtherScoreRow = QuarantinedScoreRow & {
  retired: boolean
}

/** Names the newest score row that safely supersedes a quarantined score mutation. */
export function supersedingScoreOutboxRow(
  quarantined: QuarantinedScoreRow,
  others: readonly OtherScoreRow[],
): number | null {
  let supersedingId: number | null = null
  for (const row of others) {
    if (
      row.id > quarantined.id &&
      !row.retired &&
      row.scoredAt >= quarantined.scoredAt &&
      (supersedingId === null || row.id > supersedingId)
    ) {
      supersedingId = row.id
    }
  }
  return supersedingId
}

type StoredScoreRow = {
  id: number
  row_id: string
  payload: string
  retired_at: string | null
}

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
  const quarantined = database
    .query<StoredScoreRow, []>(
      `SELECT id,row_id,payload,retired_at
         FROM outbox INDEXED BY outbox_row_history
        WHERE kind='score' AND quarantined_at IS NOT NULL AND retired_at IS NULL
        ORDER BY row_id,id`,
    )
    .all()
  let retired = 0
  for (const row of quarantined) {
    const quarantinedScoredAt = scoredAt(row.payload)
    if (quarantinedScoredAt === null) continue
    const related = database
      .query<StoredScoreRow, [string]>(
        `SELECT id,row_id,payload,retired_at
           FROM outbox INDEXED BY outbox_row_history
          WHERE kind='score'
            AND row_id=?
          ORDER BY id`,
      )
      .all(row.row_id)
    const supersedingId = supersedingScoreOutboxRow(
      { id: row.id, scoredAt: quarantinedScoredAt },
      related.flatMap((candidate) => {
        const candidateScoredAt = scoredAt(candidate.payload)
        return candidateScoredAt === null
          ? []
          : [
              {
                id: candidate.id,
                scoredAt: candidateScoredAt,
                retired: candidate.retired_at !== null,
              },
            ]
      }),
    )
    if (supersedingId === null) continue
    retireOutboxRow(row.id, `superseded by score outbox row ${supersedingId}`, database, at, null)
    retired += 1
  }
  return retired
}

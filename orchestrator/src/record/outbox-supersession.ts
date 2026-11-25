// concern: outbox-supersession
/** Retires quarantined mutations once a later whole-state row makes them stale. */
import type { Database } from 'bun:sqlite'
import { nowIso } from '../database/db.ts'
import type { OUTBOX_PAYLOAD_CONTRACTS } from './outbox-payload-contracts.ts'
import { retireQuarantinedOutboxRowIfEligible } from './outbox-quarantine.ts'
import { QUARANTINED_UNRETIRED_OUTBOX_PREDICATE_SQL } from './outbox-read.ts'

export type QuarantinedOutboxRow = {
  id: number
  kind: string
  rowId: string
  scoredAt: string | null
}

export type OtherOutboxRow = QuarantinedOutboxRow & {
  quarantined: boolean
  retired: boolean
}

type OutboxRowComparator = (left: QuarantinedOutboxRow, right: QuarantinedOutboxRow) => number

const byId: OutboxRowComparator = (left, right) => left.id - right.id
const byScoreTime: OutboxRowComparator = (left, right) => {
  if (left.scoredAt === null) return -1
  if (right.scoredAt === null) return 1
  return left.scoredAt.localeCompare(right.scoredAt) || byId(left, right)
}

const OUTBOX_ROW_COMPARATORS = {
  run: byId,
  score: byScoreTime,
  review: byId,
  review_lens: byId,
  review_finding: byId,
  review_read: byId,
  review_funnel_decision: byId,
  release: byId,
  landing: byId,
  landing_override: byId,
  landing_review_carry: byId,
  landing_triage_snapshot: byId,
  pull_request_ci: byId,
  contention: byId,
  test_flake: byId,
  branch_disposal: byId,
  brief_injection: byId,
  context_review: byId,
  hook_emission: byId,
} as const satisfies Record<keyof typeof OUTBOX_PAYLOAD_CONTRACTS, OutboxRowComparator>

/** Names the latest row that safely supersedes a quarantined whole-state mutation. */
export function supersedingOutboxRow(
  quarantined: QuarantinedOutboxRow,
  others: readonly OtherOutboxRow[],
): OtherOutboxRow | null {
  if (quarantined.kind === 'score' && quarantined.scoredAt === null) return null
  if (!Object.hasOwn(OUTBOX_ROW_COMPARATORS, quarantined.kind)) return null
  const compare = OUTBOX_ROW_COMPARATORS[quarantined.kind as keyof typeof OUTBOX_ROW_COMPARATORS]
  let superseding: OtherOutboxRow | null = null
  for (const row of others) {
    if (
      row.kind === quarantined.kind &&
      row.rowId === quarantined.rowId &&
      !row.retired &&
      !row.quarantined &&
      compare(row, quarantined) > 0 &&
      (superseding === null || compare(row, superseding) > 0)
    ) {
      superseding = row
    }
  }
  return superseding
}

type StoredOutboxRow = {
  id: number
  kind: string
  row_id: string
  payload: string
  quarantined_at: string | null
  retired_at: string | null
}

export const QUARANTINED_OUTBOX_ROWS_FOR_SUPERSESSION_SQL = `SELECT id,kind,row_id,payload,quarantined_at,retired_at
  FROM outbox
 WHERE ${QUARANTINED_UNRETIRED_OUTBOX_PREDICATE_SQL}
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

/** Applies supersession through the ordinary audited quarantine retirement path. */
export function retireSupersededQuarantinedOutboxRows(database: Database, at = nowIso()): number {
  const quarantined = database
    .query<StoredOutboxRow, []>(QUARANTINED_OUTBOX_ROWS_FOR_SUPERSESSION_SQL)
    .all()
  let retired = 0
  for (const row of quarantined) {
    const related = database
      .query<StoredOutboxRow, [string, string]>(
        `SELECT id,kind,row_id,payload,quarantined_at,retired_at
           FROM outbox INDEXED BY outbox_row_history
          WHERE kind=? AND row_id=?
          ORDER BY id`,
      )
      .all(row.kind, row.row_id)
    const superseding = supersedingOutboxRow(
      {
        id: row.id,
        kind: row.kind,
        rowId: row.row_id,
        scoredAt: row.kind === 'score' ? scoredAt(row.payload) : null,
      },
      related.map((candidate) => ({
        id: candidate.id,
        kind: candidate.kind,
        rowId: candidate.row_id,
        scoredAt: candidate.kind === 'score' ? scoredAt(candidate.payload) : null,
        quarantined: candidate.quarantined_at !== null,
        retired: candidate.retired_at !== null,
      })),
    )
    if (superseding === null) continue
    if (
      retireQuarantinedOutboxRowIfEligible(
        row.id,
        `superseded by ${row.kind} outbox row ${superseding.id}`,
        database,
        at,
        null,
      )
    )
      retired += 1
  }
  return retired
}

import type { Database } from 'bun:sqlite'
import { db, nowIso, writeTransaction } from './db.ts'

export const KEEP_HOSTED_CHANGE_EVIDENCE_DAYS = 30

export const HOSTED_CHANGE_EVIDENCE_FAMILIES = ['task', 'note'] as const
export type HostedChangeEvidenceFamily = (typeof HOSTED_CHANGE_EVIDENCE_FAMILIES)[number]
export const HOSTED_CHANGE_EVIDENCE_KINDS = [
  'changed-upsert',
  'applied-delete',
  'skipped-delete',
] as const
export type HostedChangeEvidenceKind = (typeof HOSTED_CHANGE_EVIDENCE_KINDS)[number]

export type HostedChangeEvidenceEvent = {
  observedAt: string
  family: HostedChangeEvidenceFamily
  spaceId: string
  table: string
  rowId: string
  kind: HostedChangeEvidenceKind
  differingColumns: string[]
}

export type HostedChangeEvidenceFilters = {
  family?: HostedChangeEvidenceFamily
  space?: string
  kind?: HostedChangeEvidenceKind
}

type StoredEvent = {
  observed_at: string
  family: HostedChangeEvidenceFamily
  space_id: string
  hosted_table: string
  row_id: string
  kind: HostedChangeEvidenceKind
  differing_columns: string
}

const eventFromRow = (row: StoredEvent): HostedChangeEvidenceEvent => ({
  observedAt: row.observed_at,
  family: row.family,
  spaceId: row.space_id,
  table: row.hosted_table,
  rowId: row.row_id,
  kind: row.kind,
  differingColumns: JSON.parse(row.differing_columns) as string[],
})

export function recordHostedChangeEvidence(
  conn: Database,
  event: Omit<HostedChangeEvidenceEvent, 'observedAt'> & { observedAt?: string },
) {
  conn
    .query(
      `INSERT INTO hosted_change_evidence
       (observed_at,family,space_id,hosted_table,row_id,kind,differing_columns)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      event.observedAt ?? nowIso(),
      event.family,
      event.spaceId,
      event.table,
      event.rowId,
      event.kind,
      JSON.stringify(event.differingColumns),
    )
}

export function pruneHostedChangeEvidence(clock = Date.now()) {
  const cutoff = new Date(clock - KEEP_HOSTED_CHANGE_EVIDENCE_DAYS * 86_400_000).toISOString()
  return writeTransaction(
    (conn) =>
      conn.query('DELETE FROM hosted_change_evidence WHERE observed_at < ?').run(cutoff).changes,
  )
}

export function listHostedChangeEvidence(
  filters: HostedChangeEvidenceFilters = {},
): HostedChangeEvidenceEvent[] {
  return db()
    .query<
      StoredEvent,
      [string | null, string | null, string | null, string | null, string | null, string | null]
    >(
      `SELECT observed_at,family,space_id,hosted_table,row_id,kind,differing_columns
       FROM hosted_change_evidence
       WHERE (? IS NULL OR family=?)
         AND (? IS NULL OR space_id=?)
         AND (? IS NULL OR kind=?)
       ORDER BY observed_at DESC,id DESC`,
    )
    .all(
      filters.family ?? null,
      filters.family ?? null,
      filters.space ?? null,
      filters.space ?? null,
      filters.kind ?? null,
      filters.kind ?? null,
    )
    .map(eventFromRow)
}

export type HostedChangeEvidenceSummary = {
  table: string
  differingColumns: string[]
  count: number
}

export function summarizeHostedChangeEvidence(
  filters: HostedChangeEvidenceFilters = {},
): HostedChangeEvidenceSummary[] {
  const rows = db()
    .query<
      { hosted_table: string; differing_columns: string; count: number },
      [string | null, string | null, string | null, string | null, string | null, string | null]
    >(
      `SELECT hosted_table,differing_columns,COUNT(*) count
       FROM hosted_change_evidence
       WHERE (? IS NULL OR family=?)
         AND (? IS NULL OR space_id=?)
         AND (? IS NULL OR kind=?)
       GROUP BY hosted_table,differing_columns
       ORDER BY count DESC,hosted_table,differing_columns`,
    )
    .all(
      filters.family ?? null,
      filters.family ?? null,
      filters.space ?? null,
      filters.space ?? null,
      filters.kind ?? null,
      filters.kind ?? null,
    )
  return rows.map((row) => ({
    table: row.hosted_table,
    differingColumns: JSON.parse(row.differing_columns) as string[],
    count: row.count,
  }))
}

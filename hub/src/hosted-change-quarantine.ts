import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../shared/record/schema.ts'
import type { HostedPreparedChange } from './hosted-change-family.ts'

export const HOSTED_CHANGE_QUARANTINE_ERROR_MAX_LENGTH = 500

export type HostedChangeQuarantineRow = {
  id: string
  feed: string
  spaceId: string
  table: string
  rowId: string
  rawChange: string
  constraintError: string
  firstQuarantinedAt: string
  lastQuarantinedAt: string
  sightings: number
}

export type HostedChangeQuarantineSummary = {
  count: number
  oldest: Pick<
    HostedChangeQuarantineRow,
    'feed' | 'spaceId' | 'table' | 'rowId' | 'constraintError' | 'firstQuarantinedAt'
  > | null
}

const capConstraintError = (value: string) =>
  value.length <= HOSTED_CHANGE_QUARANTINE_ERROR_MAX_LENGTH
    ? value
    : value.slice(0, HOSTED_CHANGE_QUARANTINE_ERROR_MAX_LENGTH)

function quarantineRow(row: {
  id: string
  feed: string
  space_id: string
  table_name: string
  row_id: string
  raw_change: string
  constraint_error: string
  first_quarantined_at: string
  last_quarantined_at: string
  sightings: number
}): HostedChangeQuarantineRow {
  return {
    id: row.id,
    feed: row.feed,
    spaceId: row.space_id,
    table: row.table_name,
    rowId: row.row_id,
    rawChange: row.raw_change,
    constraintError: row.constraint_error,
    firstQuarantinedAt: row.first_quarantined_at,
    lastQuarantinedAt: row.last_quarantined_at,
    sightings: row.sightings,
  }
}

export function recordHostedChangeQuarantine(
  conn: Database,
  feed: string,
  spaceId: string,
  change: HostedPreparedChange,
  constraintError: string,
  at = new Date().toISOString(),
): void {
  conn
    .query(
      `INSERT INTO hosted_change_quarantine
       (id,feed,space_id,table_name,row_id,raw_change,constraint_error,
        first_quarantined_at,last_quarantined_at,sightings)
       VALUES (?,?,?,?,?,?,?,?,?,1)
       ON CONFLICT(feed,space_id,table_name,row_id) DO UPDATE SET
       raw_change=excluded.raw_change,constraint_error=excluded.constraint_error,
       last_quarantined_at=excluded.last_quarantined_at,
       sightings=hosted_change_quarantine.sightings+1`,
    )
    .run(
      newRecordId(),
      feed,
      spaceId,
      change.table,
      change.id,
      JSON.stringify(change),
      capConstraintError(constraintError),
      at,
      at,
    )
}

export function clearHostedChangeQuarantine(
  conn: Database,
  feed: string,
  spaceId: string,
  change: Pick<HostedPreparedChange, 'table' | 'id'>,
): void {
  conn
    .query(
      `DELETE FROM hosted_change_quarantine
       WHERE feed=? AND space_id=? AND table_name=? AND row_id=?`,
    )
    .run(feed, spaceId, change.table, change.id)
}

export function hostedChangeQuarantineRows(conn: Database): HostedChangeQuarantineRow[] {
  return conn
    .query(
      `SELECT id,feed,space_id,table_name,row_id,raw_change,constraint_error,
       first_quarantined_at,last_quarantined_at,sightings
       FROM hosted_change_quarantine ORDER BY first_quarantined_at,id`,
    )
    .all()
    .map((row) => quarantineRow(row as Parameters<typeof quarantineRow>[0]))
}

export function hostedChangeQuarantineSummary(conn: Database): HostedChangeQuarantineSummary {
  const rows = hostedChangeQuarantineRows(conn)
  const oldest = rows[0]
  return {
    count: rows.length,
    oldest: oldest
      ? {
          feed: oldest.feed,
          spaceId: oldest.spaceId,
          table: oldest.table,
          rowId: oldest.rowId,
          constraintError: oldest.constraintError,
          firstQuarantinedAt: oldest.firstQuarantinedAt,
        }
      : null,
  }
}

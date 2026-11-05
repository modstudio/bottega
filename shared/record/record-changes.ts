// concern: record-changes
/** Reads the global record_change log on an (xid8, seq) cursor, with the horizon as its reset watermark. Knows nothing of hub_change, HTTP, or any table's wire form. */

import { Buffer } from 'node:buffer'
import type { SQL } from 'bun'
import { bindTenant, type TenantPrincipal } from './tenant.ts'

export const MAX_RECORD_CHANGE_PAGE_SIZE = 500

export type RecordChangeCursor = { xid: bigint; seq: bigint }
export type RecordChangeEntry = {
  xid: bigint
  seq: bigint
  table: string
  id: string
  space: string
  op: 'upsert' | 'delete'
}

type LogRow = {
  xid: string | number | bigint
  seq: string | number | bigint
  table_name: string
  row_id: string
  space_id: string
  op: 'upsert' | 'delete'
}
const rows = <T>(value: unknown) => value as T[]
const asBigInt = (value: string | number | bigint) => BigInt(value)
const before = (left: RecordChangeCursor, right: RecordChangeCursor) =>
  left.xid < right.xid || (left.xid === right.xid && left.seq < right.seq)

export function encodeRecordChangeCursor(cursor: RecordChangeCursor): string {
  return Buffer.from(
    JSON.stringify({ xid: cursor.xid.toString(), seq: cursor.seq.toString() }),
  ).toString('base64url')
}

export function decodeRecordChangeCursor(value: string): RecordChangeCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('xid' in parsed) ||
      !('seq' in parsed) ||
      typeof parsed.xid !== 'string' ||
      typeof parsed.seq !== 'string' ||
      !/^\d+$/.test(parsed.xid) ||
      !/^\d+$/.test(parsed.seq)
    )
      throw new Error('shape')
    return { xid: BigInt(parsed.xid), seq: BigInt(parsed.seq) }
  } catch {
    throw new Error('record change cursor is malformed')
  }
}

export function recordChangeResetRequired(
  after: RecordChangeCursor | null,
  horizon: RecordChangeCursor,
): after is null {
  return after === null || before(after, horizon)
}

export function recordChangePage(after: RecordChangeCursor, candidates: readonly LogRow[]) {
  const changes: RecordChangeEntry[] = candidates.map((row) => ({
    xid: asBigInt(row.xid),
    seq: asBigInt(row.seq),
    table: row.table_name,
    id: row.row_id,
    space: row.space_id,
    op: row.op,
  }))
  const last = changes.at(-1)
  return { changes, cursor: last ? { xid: last.xid, seq: last.seq } : after }
}

async function recordChangeLag(
  tx: SQL,
  cursor: RecordChangeCursor,
  tables: readonly string[],
): Promise<number> {
  const result = rows<{ lag: string | number | bigint }>(
    await tx`SELECT count(*)::text AS lag FROM record_change
      WHERE (xid,seq)>(${cursor.xid.toString()}::xid8,${cursor.seq})
        AND table_name=ANY(string_to_array(${tables.join(',')}, ',')::text[])`,
  )[0]!
  const lag = Number(result.lag)
  if (!Number.isSafeInteger(lag)) throw new Error('record change lag exceeds a safe integer')
  return lag
}

async function readRecordChangesInTransaction(
  tx: SQL,
  after: RecordChangeCursor | null,
  limit: number,
  tables: readonly string[],
) {
  const metadata = rows<{
    horizon_xid: string | number | bigint
    horizon_seq: string | number | bigint
  }>(
    await tx`SELECT xid::text AS horizon_xid,seq::text AS horizon_seq
      FROM record_change_horizon WHERE singleton`,
  )[0]!
  const horizon = { xid: asBigInt(metadata.horizon_xid), seq: asBigInt(metadata.horizon_seq) }
  if (recordChangeResetRequired(after, horizon))
    return {
      resetRequired: true as const,
      horizon,
      cursor: horizon,
      lag: await recordChangeLag(tx, horizon, tables),
    }
  const candidates = rows<LogRow>(
    await tx`SELECT xid::text,seq::text,table_name,row_id::text,space_id::text,op
      FROM record_change
      WHERE xid<pg_snapshot_xmin(pg_current_snapshot())
        AND (xid,seq)>(${after.xid.toString()}::xid8,${after.seq})
        AND table_name=ANY(string_to_array(${tables.join(',')}, ',')::text[])
      ORDER BY record_change.xid,record_change.seq LIMIT ${limit}`,
  )
  const page = recordChangePage(after, candidates)
  let cursor = page.cursor
  if (candidates.length < limit) {
    const bound = rows<{ xid: string | number | bigint; seq: string | number | bigint }>(
      await tx`SELECT xid::text,seq::text FROM record_change
        WHERE xid<pg_snapshot_xmin(pg_current_snapshot())
          AND (xid,seq)>(${after.xid.toString()}::xid8,${after.seq})
        ORDER BY xid DESC,seq DESC LIMIT 1`,
    )[0]
    if (bound) {
      const final = { xid: asBigInt(bound.xid), seq: asBigInt(bound.seq) }
      if (before(cursor, final)) cursor = final
    }
  }
  return {
    resetRequired: false as const,
    changes: page.changes,
    cursor,
    lag: await recordChangeLag(tx, cursor, tables),
    more: candidates.length === limit,
  }
}

type RecordChangeReadPage = Awaited<ReturnType<typeof readRecordChangesInTransaction>>

export function readRecordChanges(
  client: SQL,
  principal: TenantPrincipal,
  after: RecordChangeCursor | null,
  limit: number,
  tables: readonly string[],
): Promise<RecordChangeReadPage>
export function readRecordChanges<T>(
  client: SQL,
  principal: TenantPrincipal,
  after: RecordChangeCursor | null,
  limit: number,
  tables: readonly string[],
  materialize: (tx: SQL, page: RecordChangeReadPage) => Promise<T>,
): Promise<T>
export async function readRecordChanges(
  client: SQL,
  principal: TenantPrincipal,
  after: RecordChangeCursor | null,
  limit: number,
  tables: readonly string[],
  materialize?: (tx: SQL, page: RecordChangeReadPage) => Promise<unknown>,
) {
  return client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
    await bindTenant(tx, { ...principal, spaceIds: principal.spaceIds ?? [principal.spaceId] })
    const page = await readRecordChangesInTransaction(tx, after, limit, tables)
    return materialize ? materialize(tx, page) : page
  })
}

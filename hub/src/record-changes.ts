// concern: hosted-record-change-reader
/** Reads the committed prefix of the tenant-bound hosted replication log. */

import type { SQL } from 'bun'
import { bindTenant } from '../../shared/record/tenant.ts'
import type { TaskIdentity } from './hosted-tenant.ts'

export type RecordChange = {
  seq: bigint
  table: string
  rowId: string
  op: 'upsert' | 'delete'
  at: string
}

type ChangeRow = {
  seq: string | number | bigint
  table_name: string
  row_id: string
  op: 'upsert' | 'delete'
  at: string | Date
  below_cutoff: boolean
}

const rows = <T>(value: unknown) => value as T[]
const asBigInt = (value: string | number | bigint) => BigInt(value)

export async function readRecordChangesInTransaction(
  tx: SQL,
  after: bigint,
  limit: number,
) {
  const metadata = rows<{ horizon: string | number | bigint; newest: string | number | bigint }>(
    await tx`SELECT
      (SELECT seq FROM record_change_horizon WHERE singleton)::text AS horizon,
      COALESCE((SELECT max(seq) FROM record_change), 0)::text AS newest`,
  )[0]!
  const horizon = asBigInt(metadata.horizon)
  const newest = asBigInt(metadata.newest)
  if (after < horizon) {
    return {
      resetRequired: true as const,
      horizon,
      cursor: horizon,
      lag: newest > horizon ? newest - horizon : 0n,
    }
  }

  const candidates = rows<ChangeRow>(
    await tx`SELECT seq::text, table_name, row_id::text, op, at,
      xid < pg_snapshot_xmin(pg_current_snapshot()) AS below_cutoff
    FROM record_change
    WHERE seq > ${after}
    ORDER BY seq
    LIMIT ${limit}`,
  )
  const blockedAt = candidates.findIndex((row) => !row.below_cutoff)
  const selected = blockedAt === -1 ? candidates : candidates.slice(0, blockedAt)
  const changes: RecordChange[] = selected.map((row) => ({
    seq: asBigInt(row.seq),
    table: row.table_name,
    rowId: row.row_id,
    op: row.op,
    at: new Date(row.at).toISOString(),
  }))
  const cursor = changes.at(-1)?.seq ?? after
  return {
    resetRequired: false as const,
    changes,
    cursor,
    lag: newest > cursor ? newest - cursor : 0n,
  }
}

export async function readRecordChanges(
  client: SQL,
  identity: TaskIdentity,
  after: bigint,
  limit: number,
) {
  return client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
    await bindTenant(tx, identity)
    return readRecordChangesInTransaction(tx, after, limit)
  })
}

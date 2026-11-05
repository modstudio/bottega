// concern: hosted record storage measurement
/** Reads relation size and churn only from PostgreSQL catalogs. */

import type { TableStorageMeasurement } from '../../../shared/storage-lifecycle.ts'
import { recordPool } from './record-pool.ts'

export async function readRecordStorage(url: string): Promise<TableStorageMeasurement[]> {
  const rows = await recordPool(url)<
    {
      table_name: string
      bytes: string | number
      n_live_tup: string | number
      n_tup_upd: string | number
      n_dead_tup: string | number
    }[]
  >`
    SELECT s.relname AS table_name,
           pg_total_relation_size(s.relid)::text AS bytes,
           s.n_live_tup::text, s.n_tup_upd::text, s.n_dead_tup::text
    FROM pg_stat_user_tables s
    WHERE s.schemaname='public'
    ORDER BY s.relname
  `
  return rows.map((row) => ({
    store: 'hosted',
    table: String(row.table_name),
    bytes: Number(row.bytes),
    rows: Number(row.n_live_tup),
    nLiveTup: Number(row.n_live_tup),
    nTupUpd: Number(row.n_tup_upd),
    nDeadTup: Number(row.n_dead_tup),
  }))
}

// concern: record-install-binding-write
/** Records the first successful attachment to a hosted record. */

import type { Database } from 'bun:sqlite'
import { resolvedRecordOrigin } from '../../../shared/record-api-url.ts'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { recordInstallBindingHasOrigin } from './install-binding.ts'

export function rememberHostedRecord(database: Database = db()): void {
  const recordOrigin = resolvedRecordOrigin()
  writeTransaction(() => {
    const hasOrigin = recordInstallBindingHasOrigin(database)
    if (!hasOrigin) {
      database
        .query(
          `INSERT INTO record_install_binding (id, bound_at) VALUES (1, ?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .run(nowIso())
      return
    }
    database
      .query(
        `INSERT INTO record_install_binding (id, bound_at, record_origin) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET record_origin=COALESCE(record_install_binding.record_origin, excluded.record_origin)`,
      )
      .run(nowIso(), recordOrigin)
  }, database)
}

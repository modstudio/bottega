// concern: record-install-binding-write
/** Records the first successful attachment to a hosted record. */

import type { Database } from 'bun:sqlite'
import { db, nowIso, writeTransaction } from '../database/db.ts'

export function rememberHostedRecord(database: Database = db()): void {
  writeTransaction(() => {
    database
      .query(
        `INSERT INTO record_install_binding (id, bound_at) VALUES (1, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(nowIso())
  }, database)
}

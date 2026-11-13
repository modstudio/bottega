// concern: brief-injection-outbox
/** Backfills hosted-record mutations for local brief-injection events. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { nowIso } from '../database/db.ts'
import { machineId } from './machine-identity.ts'
import { insertOutboxRow } from './outbox-enqueue.ts'
import { stringifyOutboxPayload } from './outbox-sanitize.ts'

type BriefInjectionRow = {
  record_id: string
  session_id: string
  at: string
  source: string
  bytes: number
  lines: number
  cursors: number
  keyless_cursors: number
  keyless_idle_max_ms: number | null
  over_cap: number
}

export function backfillBriefInjections(database: Database, updatedAt = nowIso()): number {
  const rows = database
    .query<BriefInjectionRow, []>(
      `SELECT record_id,session_id,at,source,bytes,lines,cursors,keyless_cursors,
              keyless_idle_max_ms,over_cap
         FROM brief_injection
        WHERE NOT EXISTS (SELECT 1 FROM outbox
                          WHERE kind='brief_injection' AND row_id=brief_injection.record_id)
        ORDER BY at,record_id`,
    )
    .all()
  for (const row of rows) {
    const payload = stringifyOutboxPayload('brief_injection', {
      id: row.record_id,
      spaceId: PLATFORM_SPACE_ID,
      machineId: machineId(),
      localId: null,
      sessionId: row.session_id,
      at: row.at,
      source: row.source,
      bytes: row.bytes,
      lines: row.lines,
      cursors: row.cursors,
      keylessCursors: row.keyless_cursors,
      keylessIdleMaxMs: row.keyless_idle_max_ms,
      overCap: Boolean(row.over_cap),
      createdAt: row.at,
      updatedAt,
    })
    insertOutboxRow(database, {
      recordId: newRecordId(),
      kind: 'brief_injection',
      rowId: row.record_id,
      payload,
      createdAt: updatedAt,
    })
  }
  return rows.length
}

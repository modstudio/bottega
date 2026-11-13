// concern: brief-injection-outbox
/** Backfills hosted-record mutations for local brief-injection events. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { nowIso } from '../database/db.ts'
import { machineId } from './machine-identity.ts'
import { insertOutboxRow } from './outbox-enqueue.ts'
import { stringifyOutboxPayload } from './outbox-sanitize.ts'

type BriefInjectionPayloadRow = {
  id: string
  sessionId: string
  at: string
  source: string
  bytes: number
  lines: number
  cursors: number
  keylessCursors: number
  keylessIdleMaxMs: number | null
  overCap: boolean | number
}

export function buildBriefInjectionPayload(
  row: BriefInjectionPayloadRow,
  rowMachineId: string,
  updatedAt: string,
) {
  return {
    id: row.id,
    spaceId: PLATFORM_SPACE_ID,
    machineId: rowMachineId,
    localId: null,
    sessionId: row.sessionId,
    at: row.at,
    source: row.source,
    bytes: row.bytes,
    lines: row.lines,
    cursors: row.cursors,
    keylessCursors: row.keylessCursors,
    keylessIdleMaxMs: row.keylessIdleMaxMs,
    overCap: Boolean(row.overCap),
    createdAt: row.at,
    updatedAt,
  }
}

export function backfillBriefInjections(database: Database, updatedAt = nowIso()): number {
  const rows = database
    .query<BriefInjectionPayloadRow, []>(
      `SELECT record_id AS id,session_id AS sessionId,at,source,bytes,lines,cursors,
              keyless_cursors AS keylessCursors,keyless_idle_max_ms AS keylessIdleMaxMs,
              over_cap = 1 AS overCap
         FROM brief_injection
        WHERE NOT EXISTS (SELECT 1 FROM outbox
                          WHERE kind='brief_injection' AND row_id=brief_injection.record_id)
        ORDER BY at,record_id`,
    )
    .all()
  for (const row of rows) {
    const payload = stringifyOutboxPayload(
      'brief_injection',
      buildBriefInjectionPayload(row, machineId(), updatedAt),
    )
    insertOutboxRow(database, {
      recordId: newRecordId(),
      kind: 'brief_injection',
      rowId: row.id,
      payload,
      createdAt: updatedAt,
    })
  }
  return rows.length
}

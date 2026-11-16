// concern: hook-emission-outbox
/** Builds hosted-record mutations for local hook-emission events. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { nowIso } from '../database/db.ts'
import { machineId } from './machine-identity.ts'
import { insertOutboxRow } from './outbox-enqueue.ts'
import { stringifyOutboxPayload } from './outbox-sanitize.ts'

export function buildHookEmissionPayload(
  row: {
    id: string
    sessionId: string
    at: string
    event: string
    hook: string
    kind: string
    chars: number
    lines: number
    textHash: string
  },
  machineId: string,
  updatedAt: string,
) {
  return {
    id: row.id,
    spaceId: PLATFORM_SPACE_ID,
    machineId,
    localId: null,
    sessionId: row.sessionId,
    at: row.at,
    event: row.event,
    hook: row.hook,
    kind: row.kind,
    chars: row.chars,
    lines: row.lines,
    textHash: row.textHash,
    createdAt: row.at,
    updatedAt,
  }
}

export function backfillHookEmissions(database: Database, updatedAt = nowIso()): number {
  const rows = database
    .query<
      {
        id: string
        sessionId: string
        at: string
        event: string
        hook: string
        kind: string
        chars: number
        lines: number
        textHash: string
      },
      []
    >(
      `SELECT record_id id,session_id sessionId,at,event,hook,kind,chars,lines,text_hash textHash
       FROM hook_emission WHERE NOT EXISTS (SELECT 1 FROM outbox WHERE kind='hook_emission' AND row_id=hook_emission.record_id)
       ORDER BY at,record_id`,
    )
    .all()
  for (const row of rows)
    insertOutboxRow(database, {
      recordId: newRecordId(),
      kind: 'hook_emission',
      rowId: row.id,
      payload: stringifyOutboxPayload(
        'hook_emission',
        buildHookEmissionPayload(row, machineId(), updatedAt),
      ),
      createdAt: updatedAt,
    })
  return rows.length
}

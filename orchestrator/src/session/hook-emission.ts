// concern: hook-emission
/** Records one product-hook output without retaining its text. */

import type { Database } from 'bun:sqlite'
import { HOOK_EMISSION_KINDS } from '../../../shared/record/schema-session.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { buildHookEmissionPayload } from '../record/hook-emission-outbox.ts'
import { machineId } from '../record/machine-identity.ts'
import { insertOutboxRow } from '../record/outbox-enqueue.ts'
import { stringifyOutboxPayload } from '../record/outbox-sanitize.ts'

export { HOOK_EMISSION_KINDS }

type HookEmissionKind = (typeof HOOK_EMISSION_KINDS)[number]

export type HookEmissionInput = {
  sessionId: string
  event: string
  hook: string
  kind: HookEmissionKind
  chars: number
  lines: number
  textHash: string
}
export type HookEmission = HookEmissionInput & { id: string; at: string }

export function recordHookEmission(
  input: HookEmissionInput,
  dependencies: { database?: Database; now?: () => string; machine?: () => string } = {},
): HookEmission {
  const database = dependencies.database ?? db(true)
  const row = { ...input, id: newRecordId(), at: (dependencies.now ?? nowIso)() }
  writeTransaction(() => {
    database
      .query(`INSERT INTO hook_emission
        (record_id,session_id,at,event,hook,kind,chars,lines,text_hash)
        VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(
        row.id,
        row.sessionId,
        row.at,
        row.event,
        row.hook,
        row.kind,
        row.chars,
        row.lines,
        row.textHash,
      )
    insertOutboxRow(database, {
      recordId: newRecordId(),
      kind: 'hook_emission',
      rowId: row.id,
      payload: stringifyOutboxPayload(
        'hook_emission',
        buildHookEmissionPayload(row, (dependencies.machine ?? machineId)(), row.at),
      ),
      createdAt: row.at,
    })
  }, database)
  return row
}

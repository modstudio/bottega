// concern: brief-injection
/** Records one SessionStart context delivery and its open-cursor facts. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'
import { SESSION_START_SOURCES } from '../../../shared/record/schema-session.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'
import { insertOutboxRow } from '../record/outbox-enqueue.ts'
import { stringifyOutboxPayload } from '../record/outbox-sanitize.ts'
import { type TaskFlowOpenSessionStageRow, taskFlowReadStore } from '../workflow/task-flow-store.ts'
import { SESSION_START_CONTEXT_MAX_CHARS } from './session-start-context-limit.ts'

export { SESSION_START_SOURCES }

type SessionStartSource = (typeof SESSION_START_SOURCES)[number]

export type BriefInjectionInput = {
  sessionId: string
  source: SessionStartSource
  bytes: number
  lines: number
  chars: number
}

export type BriefInjection = BriefInjectionInput & {
  id: string
  at: string
  cursors: number
  keylessCursors: number
  keylessIdleMaxMs: number | null
  overCap: boolean
}

function wholeNonnegative(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a nonnegative integer`)
}

export function briefInjectionCursorFacts(
  rows: readonly Pick<TaskFlowOpenSessionStageRow, 'workflow_key' | 'updated_at'>[],
  atMs: number,
): Pick<BriefInjection, 'cursors' | 'keylessCursors' | 'keylessIdleMaxMs'> {
  const keyless = rows.filter((row) => row.workflow_key === '')
  const idle = keyless
    .map((row) => Math.max(0, atMs - Date.parse(row.updated_at)))
    .filter(Number.isFinite)
  return {
    cursors: rows.length,
    keylessCursors: keyless.length,
    keylessIdleMaxMs: idle.length ? Math.max(...idle) : null,
  }
}

export async function recordBriefInjection(
  input: BriefInjectionInput,
  dependencies: { database?: Database; now?: () => string; machine?: () => string } = {},
): Promise<BriefInjection> {
  if (!input.sessionId) throw new Error('session id is required')
  if (!SESSION_START_SOURCES.includes(input.source)) throw new Error('invalid SessionStart source')
  wholeNonnegative(input.bytes, 'bytes')
  wholeNonnegative(input.lines, 'lines')
  wholeNonnegative(input.chars, 'chars')
  const database = dependencies.database ?? db(true)
  const at = (dependencies.now ?? nowIso)()
  const cursors = await taskFlowReadStore(database).openStagesForSession(input.sessionId)
  const facts = briefInjectionCursorFacts(cursors, Date.parse(at))
  const row: BriefInjection = {
    ...input,
    id: newRecordId(),
    at,
    ...facts,
    overCap: input.chars > SESSION_START_CONTEXT_MAX_CHARS,
  }
  writeTransaction(() => {
    database
      .query(
        `INSERT INTO brief_injection
          (record_id,session_id,at,source,bytes,lines,cursors,keyless_cursors,keyless_idle_max_ms,over_cap)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id,
        row.sessionId,
        row.at,
        row.source,
        row.bytes,
        row.lines,
        row.cursors,
        row.keylessCursors,
        row.keylessIdleMaxMs,
        row.overCap ? 1 : 0,
      )
    const payload = stringifyOutboxPayload('brief_injection', {
      id: row.id,
      spaceId: PLATFORM_SPACE_ID,
      machineId: (dependencies.machine ?? machineId)(),
      localId: null,
      sessionId: row.sessionId,
      at: row.at,
      source: row.source,
      bytes: row.bytes,
      lines: row.lines,
      cursors: row.cursors,
      keylessCursors: row.keylessCursors,
      keylessIdleMaxMs: row.keylessIdleMaxMs,
      overCap: row.overCap,
      createdAt: row.at,
      updatedAt: row.at,
    })
    insertOutboxRow(database, {
      recordId: newRecordId(),
      kind: 'brief_injection',
      rowId: row.id,
      payload,
      createdAt: row.at,
    })
  }, database)
  return row
}

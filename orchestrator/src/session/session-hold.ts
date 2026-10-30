// concern: session board holds
/** Records and releases the board messages whose changes should wake one session. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { resolveBoardMessageIdentifier } from '../board/board-message-identifier.ts'
import { db, nowIso, writableDb, writeTransaction } from '../database/db.ts'

type SessionHold = {
  recordId: string
  messageRecordId: string
  createdAt: string
}

type Environment = Record<string, string | undefined>

export type SessionHoldResult =
  | { action: 'held'; hold: SessionHold }
  | { action: 'already-held'; hold: SessionHold }
  | { action: 'released'; messageRecordId: string; reason: string }
  | { action: 'listed'; holds: SessionHold[] }

function callingSession(env: Environment): string {
  const session = env.CLAUDE_CODE_SESSION_ID?.trim()
  if (!session)
    throw new Error('session hold requires the calling session in CLAUDE_CODE_SESSION_ID')
  return session
}

function holds(database: Database, session: string): SessionHold[] {
  return database
    .query<{ record_id: string; message_record_id: string; created_at: string }, [string]>(
      `SELECT record_id,message_record_id,created_at FROM session_board_hold
       WHERE session_id=? AND released_at IS NULL ORDER BY created_at,record_id`,
    )
    .all(session)
    .map((row) => ({
      recordId: row.record_id,
      messageRecordId: row.message_record_id,
      createdAt: row.created_at,
    }))
}

function messageExists(database: Database, id: string): boolean {
  const local = database
    .query<{ found: number }, [string]>(
      `SELECT 1 found FROM board_message
       WHERE record_id=? AND thread_root_record_id IS NULL LIMIT 1`,
    )
    .get(id)
  if (local) return true
  return Boolean(
    database
      .query<{ found: number }, [string]>(
        `SELECT 1 found FROM hosted_board_message_cache
         WHERE id=? AND thread_root_id IS NULL LIMIT 1`,
      )
      .get(id),
  )
}

export function sessionHold(
  input: { on?: string; release?: string; reason?: string },
  options: {
    database?: Database
    env?: Environment
    at?: string
    recordId?: () => string
  } = {},
): SessionHoldResult {
  const session = callingSession(options.env ?? process.env)
  const database = options.database ?? (input.on || input.release ? writableDb() : db())
  if (input.on && input.release)
    throw new Error('choose either --on <id> or --release <id>, not both')
  if (input.reason && !input.release) throw new Error('--reason <text> requires --release <id>')
  if (input.release && !input.reason?.trim())
    throw new Error('--release <id> requires --reason <text>')
  if (!input.on && !input.release) return { action: 'listed', holds: holds(database, session) }

  const messageIdentifier = (input.on ?? input.release)!.trim()
  if (!messageIdentifier) throw new Error('board message id must not be empty')
  const messageRecordId = resolveBoardMessageIdentifier(
    database,
    messageIdentifier,
    options.env ?? process.env,
  ).recordId
  if (input.on) {
    if (!messageExists(database, messageRecordId))
      throw new Error(
        `board message ${messageRecordId} was not found; check it with ${PLATFORM_SLUG} board thread ${messageRecordId}`,
      )
    return writeTransaction(() => {
      const existing = holds(database, session).find(
        (hold) => hold.messageRecordId === messageRecordId,
      )
      if (existing) return { action: 'already-held', hold: existing }
      const hold = {
        recordId: (options.recordId ?? newRecordId)(),
        messageRecordId,
        createdAt: options.at ?? nowIso(),
      }
      database
        .query(
          `INSERT INTO session_board_hold
           (record_id,session_id,message_record_id,created_at) VALUES (?,?,?,?)`,
        )
        .run(hold.recordId, session, hold.messageRecordId, hold.createdAt)
      return { action: 'held', hold }
    }, database)
  }

  const reason = input.reason!.trim()
  const released = writeTransaction(
    () =>
      database
        .query(
          `UPDATE session_board_hold SET released_at=?,release_reason=?
           WHERE session_id=? AND message_record_id=? AND released_at IS NULL`,
        )
        .run(options.at ?? nowIso(), reason, session, messageRecordId).changes,
    database,
  )
  if (!released) throw new Error(`session has no unreleased hold on ${messageRecordId}`)
  return { action: 'released', messageRecordId, reason }
}

export function formatSessionHold(result: SessionHoldResult): string {
  if (result.action === 'held') return `holding board message ${result.hold.messageRecordId}`
  if (result.action === 'already-held')
    return `already holding board message ${result.hold.messageRecordId}`
  if (result.action === 'released')
    return `released board message ${result.messageRecordId}: ${result.reason}`
  if (!result.holds.length) return 'no unreleased board holds'
  return result.holds.map((hold) => `${hold.messageRecordId}\t${hold.createdAt}`).join('\n')
}

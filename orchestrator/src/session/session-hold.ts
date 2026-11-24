// concern: session board holds
/** Records and releases the board messages whose changes should wake one session. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  type BoardIdentifierRefresh,
  boardMessageKind,
  refreshHostedBoardIdentifier,
  resolveBoardMessageIdentifier,
} from '../board/board-message-identifier.ts'
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

function assertThreadRoot(database: Database, id: string, source: 'local' | 'hosted'): void {
  const kind = boardMessageKind(database, id, source)
  if (kind === 'reply')
    throw new Error(
      `board message ${id} is a reply, not a thread root; hold its thread root (see ${PLATFORM_SLUG} board thread ${id})`,
    )
  if (kind === 'missing')
    throw new Error(
      `board message ${id} was not found; check it with ${PLATFORM_SLUG} board thread ${id}`,
    )
}

export async function sessionHold(
  input: { on?: string; release?: string; reason?: string },
  options: {
    database?: Database
    env?: Environment
    at?: string
    recordId?: () => string
    refresh?: BoardIdentifierRefresh
  } = {},
): Promise<SessionHoldResult> {
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
  // Release skips the board-mode check because a hold row already stores a record id.
  const validateHosted = input.release === undefined
  const resolved = resolveBoardMessageIdentifier(
    database,
    messageIdentifier,
    options.env ?? process.env,
    validateHosted,
  )
  const messageRecordId = resolved.recordId
  if (input.on) {
    if (resolved.source === 'hosted') {
      await refreshHostedBoardIdentifier(database, options.env ?? process.env, options.refresh)
    }
    assertThreadRoot(database, messageRecordId, resolved.source)
    return writeTransaction((): SessionHoldResult => {
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

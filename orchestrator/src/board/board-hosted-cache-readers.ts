// concern: hosted-board-read-cache
/** Narrow reads over the hosted board cache's private row shapes. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import type { HostedBoardMessage } from '../record/record-board-contract.ts'
import { messageIsLive } from './board-policy.ts'

export const hostedMessageIsLive = (message: HostedBoardMessage, clock: number): boolean =>
  messageIsLive(
    {
      expiresAt: message.expiresAt ? Date.parse(message.expiresAt) : 0,
      withdrawnAt: message.withdrawnAt ? Date.parse(message.withdrawnAt) : null,
    },
    clock,
  )

export function cachedHostedBoardMessageKind(
  recordId: string,
  database: Database = db(),
): 'root' | 'reply' | 'missing' {
  const row = database
    .query<{ thread_root_id: string | null }, [string]>(
      'SELECT thread_root_id FROM hosted_board_message_cache WHERE id=? LIMIT 1',
    )
    .get(recordId)
  if (!row) return 'missing'
  return row.thread_root_id === null ? 'root' : 'reply'
}

export type CachedHostedBoardReceiptFacts = {
  readerSession: string
  readerRunRecordId: string | null
  audienceAtPosting: boolean
  acknowledgedAt: string | null
}

export function cachedHostedBoardReceiptFacts(
  messageId: string,
  database: Database = db(),
): CachedHostedBoardReceiptFacts[] {
  const rows = database
    .query(
      `SELECT reader_session,reader_run_record_id,audience_at_posting,acknowledged_at
       FROM hosted_board_receipt_cache WHERE message_id=?`,
    )
    .all(messageId) as Array<{
    reader_session: string
    reader_run_record_id: string | null
    audience_at_posting: number
    acknowledged_at: string | null
  }>
  return rows.map((row) => ({
    readerSession: row.reader_session,
    readerRunRecordId: row.reader_run_record_id,
    audienceAtPosting: row.audience_at_posting === 1,
    acknowledgedAt: row.acknowledged_at,
  }))
}

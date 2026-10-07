// concern: board-push-service
/** Resolves pending acknowledgement delivery across the local and hosted caches. */

import type { Database } from 'bun:sqlite'
import { writableDb } from '../database/db.ts'
import {
  cachedMessageAddressed,
  cachedRows,
  markCachedHostedDelivered,
  refreshHostedBoard,
} from './board-hosted-cache.ts'
import { requireRealSession } from './board-policy.ts'
import type { PendingAcknowledgement } from './board-render.ts'
import { markNoticesDelivered } from './board-service.ts'
import { addressed, boardOrigin, messageRows, originText, rowIsLive } from './board-store.ts'

type PendingInput = {
  session: string
  deliver: boolean
  budgetMs: number
  clock?: number
  database?: Database
}

const receiptAt = (database: Database, table: string, id: string | number, session: string) =>
  (database
    .query(
      `SELECT delivered_at,acknowledged_at FROM ${table} WHERE message_id=? AND reader_session=?`,
    )
    .get(id, session) as {
    delivered_at: string | null
    acknowledged_at: string | null
  } | null) ?? { delivered_at: null, acknowledged_at: null }

function localPending(
  session: string,
  clock: number,
  database: Database,
): PendingAcknowledgement[] {
  return messageRows(database)
    .filter((row) => {
      const receipt = receiptAt(database, 'board_receipt', row.id, session)
      return (
        row.kind === 'notice' &&
        row.ack_required === 1 &&
        row.author_session !== session &&
        rowIsLive(row, clock) &&
        addressed(row, session, clock) &&
        receipt.acknowledged_at === null
      )
    })
    .map((row) => ({
      id: String(row.id),
      author: originText(boardOrigin(row)),
      title: row.title ?? '',
      body: row.body,
      deadline: row.ack_deadline ?? '',
      deliveredAt: receiptAt(database, 'board_receipt', row.id, session).delivered_at,
    }))
}

function hostedPending(
  session: string,
  clock: number,
  database: Database,
): PendingAcknowledgement[] {
  return cachedRows(database)
    .filter(({ message, tags }) => {
      const receipt = receiptAt(database, 'hosted_board_receipt_cache', message.id, session)
      return (
        message.kind === 'notice' &&
        message.ackRequired &&
        message.authorSession !== session &&
        cachedMessageAddressed({ message, tags }, session, clock, database) &&
        receipt.acknowledged_at === null
      )
    })
    .map(({ message }) => ({
      id: message.id,
      author: originText(message.origin),
      title: message.title ?? '',
      body: message.body,
      deadline: message.ackDeadline ?? '',
      deliveredAt: receiptAt(database, 'hosted_board_receipt_cache', message.id, session)
        .delivered_at,
    }))
}

export async function pendingBoardAcknowledgements(input: PendingInput) {
  requireRealSession(input.session, 'board pending')
  const database = input.database ?? writableDb()
  const clock = input.clock ?? Date.now()
  await refreshHostedBoard({ budgetMs: input.budgetMs, database })
  const all = [
    ...localPending(input.session, clock, database),
    ...hostedPending(input.session, clock, database),
  ]
  if (input.deliver && all.length) {
    const firstDeliveries = all.filter((notice) => notice.deliveredAt === null)
    const local = firstDeliveries
      .filter((notice) => /^\d+$/.test(notice.id))
      .map((notice) => Number(notice.id))
    const hosted = firstDeliveries
      .filter((notice) => !/^\d+$/.test(notice.id))
      .map((notice) => notice.id)
    if (local.length)
      markNoticesDelivered(local, { CLAUDE_CODE_SESSION_ID: input.session }, clock, database)
    if (hosted.length) {
      await markCachedHostedDelivered(input.session, hosted, { database, clock })
    }
  }
  return all
}

// concern: board-push-service
/** Resolves bounded delivery and pending acknowledgement across local and hosted boards. */

import type { Database } from 'bun:sqlite'
import { writableDb } from '../database/db.ts'
import {
  cachedMessageAddressed,
  cachedRows,
  claimCachedHosted,
  markCachedHostedDelivered,
  refreshHostedBoard,
} from './board-hosted-cache.ts'
import { requireRealSession } from './board-policy.ts'
import {
  type BoardDelivery,
  boundedBoardDelivery,
  renderPendingAcknowledgement,
} from './board-render.ts'
import { claimNotices, markNoticesDelivered } from './board-service.ts'
import { addressed, boardOrigin, messageRows, originText, rowIsLive } from './board-store.ts'

type DeliveryInput = {
  session: string
  budgetMs: number
  includeAcknowledgementReminders?: boolean
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

function localPendingAcknowledgements(
  session: string,
  clock: number,
  database: Database,
): BoardDelivery[] {
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
      requiresAcknowledgement: true,
      createdAt: row.created_at,
      deliveredAt: receiptAt(database, 'board_receipt', row.id, session).delivered_at,
      text: renderPendingAcknowledgement({
        id: String(row.id),
        author: originText(boardOrigin(row)),
        title: row.title ?? '',
        body: row.body,
        deadline: row.ack_deadline ?? '',
        deliveredAt: receiptAt(database, 'board_receipt', row.id, session).delivered_at,
      }),
    }))
}

function hostedPendingAcknowledgements(
  session: string,
  clock: number,
  database: Database,
): BoardDelivery[] {
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
      requiresAcknowledgement: true,
      createdAt: message.createdAt,
      deliveredAt: receiptAt(database, 'hosted_board_receipt_cache', message.id, session)
        .delivered_at,
      text: renderPendingAcknowledgement({
        id: message.id,
        author: originText(message.origin),
        title: message.title ?? '',
        body: message.body,
        deadline: message.ackDeadline ?? '',
        deliveredAt: receiptAt(database, 'hosted_board_receipt_cache', message.id, session)
          .delivered_at,
      }),
    }))
}

export async function pendingBoardDelivery(input: DeliveryInput) {
  requireRealSession(input.session, 'board pending')
  const database = input.database ?? writableDb()
  const clock = input.clock ?? Date.now()
  if (input.budgetMs > 0) await refreshHostedBoard({ budgetMs: input.budgetMs, database })
  const env = { CLAUDE_CODE_SESSION_ID: input.session }
  const unread: BoardDelivery[] = [
    ...claimNotices(false, env, clock, database).map((message) => ({
      id: String(message.id),
      text: message.text,
      requiresAcknowledgement: message.ackRequired,
      createdAt: message.createdAt,
      deliveredAt: null,
    })),
    ...claimCachedHosted(input.session, false, clock, database)
      .filter((message) => message.text.length > 0)
      .map((message) => ({
        id: message.id,
        text: message.text,
        requiresAcknowledgement: message.ackRequired,
        createdAt: message.createdAt,
        deliveredAt: null,
      })),
  ]
  const pendingAcknowledgements = [
    ...localPendingAcknowledgements(input.session, clock, database),
    ...hostedPendingAcknowledgements(input.session, clock, database),
  ]
  const candidates = input.includeAcknowledgementReminders
    ? [
        ...unread,
        ...pendingAcknowledgements.filter(
          (pending) => !unread.some((message) => message.id === pending.id),
        ),
      ]
    : unread
  const selected = boundedBoardDelivery(candidates)
  return {
    delivery: selected.messages,
    overflow: selected.overflow,
    pendingAcknowledgements,
  }
}

export async function markBoardDeliveryDelivered(input: {
  session: string
  ids: string[]
  clock?: number
  database?: Database
}): Promise<void> {
  requireRealSession(input.session, 'board delivery acknowledgement')
  const database = input.database ?? writableDb()
  const clock = input.clock ?? Date.now()
  const local = input.ids.filter((id) => /^\d+$/.test(id)).map(Number)
  const hosted = input.ids.filter((id) => !/^\d+$/.test(id))
  if (local.length)
    markNoticesDelivered(local, { CLAUDE_CODE_SESSION_ID: input.session }, clock, database)
  if (hosted.length) await markCachedHostedDelivered(input.session, hosted, { database, clock })
}

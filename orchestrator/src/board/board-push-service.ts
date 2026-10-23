// concern: board-push-service
/** Resolves bounded delivery and pending acknowledgement across local and hosted boards. */

import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { writableDb, writeTransaction } from '../database/db.ts'
import { deliveryWarning } from './board-delivery.ts'
import {
  BOARD_RECEIPT_WRITE_BUDGET_MS,
  cachedAudienceAtPosting,
  cachedMessageAddressed,
  cachedRows,
  claimCachedHostedForPush,
  refreshHostedBoard,
  syncCachedHostedReceipt,
} from './board-hosted-cache.ts'
import { resolveBoardDeliveryIdentifier } from './board-message-identifier.ts'
import { requireRealSession } from './board-policy.ts'
import { boardPushDecision, deferredReplySuccessorWarning } from './board-push-policy.ts'
import {
  type BoardDeliveryPoint,
  noteBoardReachRecordingFailure,
  type PreparedBoardReach,
  prepareBoardReach,
  recordBoardReach,
} from './board-reach.ts'
import {
  type BoardDelivery,
  boardDeliveryForm,
  boundedBoardDelivery,
  renderPendingAcknowledgement,
} from './board-render.ts'
import { claimPushNotices, deliverableTo } from './board-service.ts'
import {
  addressed,
  boardOrigin,
  boardReaderBeganAt,
  messageRows,
  originText,
  rowIsLive,
} from './board-store.ts'

type DeliveryInput = {
  session: string
  budgetMs: number
  includeAcknowledgementReminders?: boolean
  excludeAcknowledgementRequired?: boolean
  recentlyInjectedIds?: string[]
  clock?: number
  database?: Database
  claimReplySuccessors?: boolean
}

export { deliveryWarning }

const receiptAt = (database: Database, table: string, id: string | number, session: string) =>
  (database
    .query(
      table === 'board_receipt'
        ? 'SELECT delivered_at,acknowledged_at FROM board_receipt WHERE message_record_id=? AND reader_session=?'
        : 'SELECT delivered_at,acknowledged_at FROM hosted_board_receipt_cache WHERE message_id=? AND reader_session=?',
    )
    .get(id, session) as {
    delivered_at: string | null
    acknowledged_at: string | null
  } | null) ?? { delivered_at: null, acknowledged_at: null }

function localPendingAcknowledgements(
  session: string,
  beganAt: string | null,
  clock: number,
  database: Database,
): BoardDelivery[] {
  const candidates = messageRows(database)
    .filter((row) => {
      const receipt = receiptAt(database, 'board_receipt', row.record_id, session)
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
      id: String(row.number),
      author: originText(boardOrigin(row)),
      title: row.title ?? '',
      body: row.body,
      deadline: row.ack_deadline ?? '',
      requiresAcknowledgement: true,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      deliveredAt: receiptAt(database, 'board_receipt', row.record_id, session).delivered_at,
      purpose: row.purpose ?? 'information',
      text: renderPendingAcknowledgement({
        id: String(row.number),
        author: originText(boardOrigin(row)),
        title: row.title ?? '',
        body: row.body,
        deadline: row.ack_deadline ?? '',
        deliveredAt: receiptAt(database, 'board_receipt', row.record_id, session).delivered_at,
        purpose: row.purpose ?? 'information',
      }),
    }))
  return candidates.filter(
    (candidate) =>
      boardPushDecision({
        acknowledgementRequired: true,
        postedAt: candidate.createdAt,
        acknowledgementDeadline: candidate.deadline,
        expiresAt: candidate.expiresAt,
        purpose: candidate.purpose,
        readerBeganAt: beganAt,
        clock,
      }) === 'acknowledgement',
  )
}

function hostedPendingAcknowledgements(
  session: string,
  beganAt: string | null,
  clock: number,
  database: Database,
): BoardDelivery[] {
  const candidates = cachedRows(database)
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
      expiresAt: message.expiresAt ?? message.createdAt,
      deliveredAt: receiptAt(database, 'hosted_board_receipt_cache', message.id, session)
        .delivered_at,
      purpose: message.purpose ?? 'information',
      text: renderPendingAcknowledgement({
        id: message.id,
        author: originText(message.origin),
        title: message.title ?? '',
        body: message.body,
        deadline: message.ackDeadline ?? '',
        deliveredAt: receiptAt(database, 'hosted_board_receipt_cache', message.id, session)
          .delivered_at,
        purpose: message.purpose ?? 'information',
      }),
    }))
  return candidates.filter(
    (candidate) =>
      boardPushDecision({
        acknowledgementRequired: true,
        postedAt: candidate.createdAt,
        acknowledgementDeadline: candidate.deadline,
        expiresAt: candidate.expiresAt,
        purpose: candidate.purpose,
        readerBeganAt: beganAt,
        clock,
      }) === 'acknowledgement',
  )
}

export async function pendingBoardDelivery(input: DeliveryInput) {
  requireRealSession(input.session, 'board pending')
  const database = input.database ?? writableDb()
  const clock = input.clock ?? Date.now()
  if (input.budgetMs > 0) await refreshHostedBoard({ budgetMs: input.budgetMs, database })
  const env = { CLAUDE_CODE_SESSION_ID: input.session }
  const beganAt = boardReaderBeganAt(input.session, database)
  const claimReplySuccessors = input.claimReplySuccessors ?? true
  const localPush = claimPushNotices(false, env, clock, database, claimReplySuccessors)
  const hostedPush = claimCachedHostedForPush(
    input.session,
    false,
    clock,
    database,
    claimReplySuccessors,
  )
  const unread: BoardDelivery[] = [
    ...localPush.notices.map((message) => ({
      id: String(message.number),
      text:
        boardDeliveryForm(message.purpose, 'running') === 'full' ? message.text : message.oneLine,
      requiresAcknowledgement: message.ackRequired,
      createdAt: message.createdAt,
      deliveredAt: null,
      purpose: message.purpose,
    })),
    ...hostedPush.notices
      .filter((message) => message.text.length > 0)
      .map((message) => ({
        id: message.id,
        text:
          boardDeliveryForm(message.purpose, 'running') === 'full' ? message.text : message.oneLine,
        requiresAcknowledgement: message.ackRequired,
        createdAt: message.createdAt,
        deliveredAt: null,
        purpose: message.purpose,
      })),
  ]
  const pendingAcknowledgements = [
    ...localPendingAcknowledgements(input.session, beganAt, clock, database),
    ...hostedPendingAcknowledgements(input.session, beganAt, clock, database),
  ]
  const recentlyInjected = new Set(input.recentlyInjectedIds ?? [])
  const candidates = input.includeAcknowledgementReminders
    ? [
        ...unread,
        ...pendingAcknowledgements.filter(
          (pending) =>
            !unread.some((message) => message.id === pending.id) &&
            !(pending.deliveredAt && recentlyInjected.has(pending.id)),
        ),
      ]
    : unread
  const selected = boundedBoardDelivery(
    input.excludeAcknowledgementRequired
      ? candidates.filter((message) => !message.requiresAcknowledgement)
      : candidates,
  )
  return {
    delivery: selected.messages,
    overflow: selected.overflow,
    pendingAcknowledgements,
    warning: deliveryWarning(
      localPush.warning,
      hostedPush.warning,
      deferredReplySuccessorWarning(
        localPush.deferredReplySuccessorCount + hostedPush.deferredReplySuccessorCount,
      ),
    ),
  }
}

export async function markBoardDeliveryDelivered(input: {
  session: string
  ids: string[]
  emissionId?: string
  deliveryPoint?: BoardDeliveryPoint
  blockedStop?: boolean
  clock?: number
  database?: Database
}): Promise<void> {
  requireRealSession(input.session, 'board delivery acknowledgement')
  const database = input.database ?? writableDb()
  const clock = input.clock ?? Date.now()
  const deliveredAt = new Date(clock).toISOString()
  if (input.deliveryPoint && !input.emissionId)
    throw new Error('board delivery measurement requires an emission identity')
  const messages = messageRows(database)
  const resolved = input.ids.flatMap((id) => {
    const identifier = resolveBoardDeliveryIdentifier(database, id)
    return identifier ? [identifier] : []
  })
  const requestedLocal = new Set(
    resolved.flatMap((identifier) => (identifier.source === 'local' ? [identifier.recordId] : [])),
  )
  const local = messages
    .filter(
      (row) =>
        requestedLocal.has(row.record_id) &&
        row.author_session !== input.session &&
        rowIsLive(row, clock, database) &&
        deliverableTo(row, input.session, clock, database),
    )
    .map((row) => row)
  const hosted = resolved
    .filter((identifier) => identifier.source === 'hosted')
    .map(({ recordId }) => ({
      id: recordId,
      posting: cachedAudienceAtPosting(recordId, input.session, database),
    }))
    .filter((row): row is { id: string; posting: boolean } => row.posting !== null)
  const reach = [
    ...local.map((row) => ({ source: 'local' as const, id: row.record_id })),
    ...hosted.map(({ id }) => ({ source: 'hosted' as const, id })),
  ]
  const prepared: PreparedBoardReach[] = []
  let preparationFailures = 0
  if (input.deliveryPoint)
    for (const item of reach) {
      try {
        prepared.push(
          prepareBoardReach(
            {
              emissionId: input.emissionId!,
              session: input.session,
              messageSource: item.source,
              messageId: item.id,
              deliveryPoint: input.deliveryPoint,
              blockedStop: input.blockedStop ?? false,
              recordedAt: deliveredAt,
            },
            database,
          ),
        )
      } catch {
        preparationFailures++
      }
    }
  writeTransaction(() => {
    const localStamp = database.query(
      `INSERT INTO board_receipt
       (message_record_id,reader_session,audience_at_posting,delivered_at,acknowledged_at,record_id)
       VALUES (?,?,0,?,NULL,?) ON CONFLICT(message_record_id,reader_session) DO UPDATE SET
       delivered_at=COALESCE(board_receipt.delivered_at,excluded.delivered_at)`,
    )
    for (const row of local)
      localStamp.run(row.record_id, input.session, deliveredAt, newRecordId())
    const hostedStamp = database.query(
      `INSERT INTO hosted_board_receipt_cache
       (message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at,pending_sync)
       VALUES (?,?,?,?,NULL,1) ON CONFLICT(message_id,reader_session) DO UPDATE SET
       delivered_at=COALESCE(hosted_board_receipt_cache.delivered_at,excluded.delivered_at),pending_sync=1`,
    )
    for (const row of hosted)
      hostedStamp.run(row.id, input.session, row.posting ? 1 : 0, deliveredAt)
    for (const row of prepared) {
      try {
        recordBoardReach(row, database)
      } catch {
        try {
          noteBoardReachRecordingFailure(database, deliveredAt)
        } catch {}
      }
    }
    for (let index = 0; index < preparationFailures; index++)
      try {
        noteBoardReachRecordingFailure(database, deliveredAt)
      } catch {}
  }, database)
  const deadline = Date.now() + BOARD_RECEIPT_WRITE_BUDGET_MS
  for (const row of hosted)
    try {
      await syncCachedHostedReceipt(input.session, row.id, row.posting, { database, deadline })
    } catch {}
}

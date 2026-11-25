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
import {
  HOSTED_BOARD_SIDE_CHANNEL_STOPPED_REMEDY,
  hostedBoardStoppedMessage,
} from './board-hosted-refresh-message.ts'
import { resolveBoardDeliveryIdentifier } from './board-message-identifier.ts'
import { boardMode, boardModeForId } from './board-mode.ts'
import { requireRealSession } from './board-policy.ts'
import {
  boardPushDecision,
  deferredReplySuccessorWarning,
  isWithdrawalDeliveryId,
  parseWithdrawalDeliveryId,
  withdrawalDeliveryId,
  withdrawalDeliveryText,
  withdrawalPending,
  withdrawalSuperseded,
} from './board-push-policy.ts'
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
  boardPendingCommand,
  boundedBoardDelivery,
  renderPendingAcknowledgement,
} from './board-render.ts'
import { claimPushNotices, deliverableTo, localBoardRows } from './board-service.ts'
import {
  addressed,
  boardOrigin,
  boardReaderBeganAt,
  machineMessageRows,
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
  refresh?: typeof refreshHostedBoard
  env?: Record<string, string | undefined>
}

export { deliveryWarning }

type ReceiptSource = 'local' | 'hosted'

type ReceiptRow = {
  delivered_at: string | null
  acknowledged_at: string | null
  proves_reach: number
}

const receiptRow = (
  database: Database,
  source: ReceiptSource,
  id: string | number,
  session: string,
): ReceiptRow | null =>
  database
    .query(
      source === 'local'
        ? `SELECT delivered_at,acknowledged_at,
                  (audience_at_posting=1 OR delivered_at IS NOT NULL) AS proves_reach
           FROM board_receipt WHERE message_record_id=? AND reader_session=?`
        : `SELECT delivered_at,acknowledged_at,
                  (audience_at_posting=1 OR delivered_at IS NOT NULL) AS proves_reach
           FROM hosted_board_receipt_cache WHERE message_id=? AND reader_session=?`,
    )
    .get(id, session) as ReceiptRow | null

const receiptAt = (
  database: Database,
  source: ReceiptSource,
  id: string | number,
  session: string,
) =>
  receiptRow(database, source, id, session) ?? {
    delivered_at: null,
    acknowledged_at: null,
    proves_reach: 0,
  }

type PendingWithdrawal = BoardDelivery & {
  messageRecordId: string
  source: 'local' | 'hosted'
}

function withdrawalWasDelivered(database: Database, session: string, messageId: string): boolean {
  return Boolean(
    database
      .query(
        `SELECT 1 FROM board_withdrawal_delivery
         WHERE reader_session=? AND message_record_id=? LIMIT 1`,
      )
      .get(session, messageId),
  )
}

function receiptProvesReach(
  database: Database,
  source: ReceiptSource,
  messageId: string,
  session: string,
): boolean {
  return receiptRow(database, source, messageId, session)?.proves_reach === 1
}

const supersessionFact = (
  authorSession: string | null,
  title: string | null,
  createdAt: string,
) => ({
  authorSession,
  title: title ?? '',
  createdAt,
})

function localSupersessionRoots(rows: ReturnType<typeof messageRows>) {
  return rows
    .filter((row) => row.thread_root_record_id === null)
    .map((row) => ({
      row,
      fact: supersessionFact(row.author_session, row.title, row.created_at),
    }))
}

function withdrawalDelivery(input: {
  id: string
  title: string
  withdrawnAt: string
  messageRecordId: string
  source: 'local' | 'hosted'
}): PendingWithdrawal {
  return {
    id: withdrawalDeliveryId(input.id),
    text: withdrawalDeliveryText(input),
    requiresAcknowledgement: false,
    createdAt: input.withdrawnAt,
    deliveredAt: null,
    purpose: 'information',
    messageRecordId: input.messageRecordId,
    source: input.source,
  }
}

function pendingWithdrawals(
  session: string,
  clock: number,
  database: Database,
  source: 'local' | 'hosted',
): PendingWithdrawal[] {
  if (source === 'local') {
    const localRows = messageRows(database)
    const localRoots = localSupersessionRoots(localRows)
    return localRows.flatMap((row) => {
      const deliveredAt = receiptAt(database, 'local', row.record_id, session).delivered_at
      if (
        !withdrawalPending({
          isRoot: row.thread_root_record_id === null,
          withdrawnReason: row.withdrawn_reason,
          withdrawnAt: row.withdrawn_at,
          deliveredAt,
          authorSession: row.author_session,
          readerSession: session,
          alreadyDelivered: withdrawalWasDelivered(database, session, row.record_id),
          now: clock,
        })
      )
        return []
      if (
        localRoots.some(
          (root) =>
            withdrawalSuperseded(supersessionFact(row.author_session, row.title, row.created_at), [
              root.fact,
            ]) && receiptProvesReach(database, 'local', root.row.record_id, session),
        )
      )
        return []
      return [
        withdrawalDelivery({
          id: String(row.number),
          title: row.title ?? '',
          withdrawnAt: row.withdrawn_at!,
          messageRecordId: row.record_id,
          source: 'local',
        }),
      ]
    })
  }
  const hostedRows = cachedRows(database)
  const hostedRoots = hostedRows
    .filter((row) => row.message.threadRootId === null)
    .map((row) => ({
      row,
      fact: supersessionFact(row.message.authorSession, row.message.title, row.message.createdAt),
    }))
  return hostedRows.flatMap((row) => {
    const { message } = row
    const deliveredAt = receiptAt(database, 'hosted', message.id, session).delivered_at
    if (
      !withdrawalPending({
        isRoot: message.threadRootId === null,
        withdrawnReason: 'author',
        withdrawnAt: message.withdrawnAt,
        deliveredAt,
        authorSession: message.authorSession,
        readerSession: session,
        alreadyDelivered: withdrawalWasDelivered(database, session, message.id),
        now: clock,
      })
    )
      return []
    if (
      hostedRoots.some(
        (root) =>
          withdrawalSuperseded(
            supersessionFact(message.authorSession, message.title, message.createdAt),
            [root.fact],
          ) && receiptProvesReach(database, 'hosted', root.row.message.id, session),
      )
    )
      return []
    return [
      withdrawalDelivery({
        id: message.id,
        title: message.title ?? '',
        withdrawnAt: message.withdrawnAt!,
        messageRecordId: message.id,
        source: 'hosted',
      }),
    ]
  })
}

function stampPendingWithdrawals(
  database: Database,
  session: string,
  requestedIds: Set<string>,
  deliveredAt: string,
): void {
  if (requestedIds.size === 0) return
  const stamp = database.query(
    `INSERT OR IGNORE INTO board_withdrawal_delivery
     (record_id,reader_session,message_record_id,source,delivered_at) VALUES (?,?,?,?,?)`,
  )
  const hostedRows = cachedRows(database)
  for (const requestedId of requestedIds) {
    const identifier = parseWithdrawalDeliveryId(requestedId)
    if (identifier === null) continue
    const resolved = resolveBoardDeliveryIdentifier(database, identifier)
    if (resolved === null) continue
    const isWithdrawnRoot =
      resolved.source === 'local'
        ? messageRows(database).some(
            (row) =>
              row.record_id === resolved.recordId &&
              row.thread_root_record_id === null &&
              row.withdrawn_at !== null,
          )
        : hostedRows.some(
            ({ message }) =>
              message.id === resolved.recordId &&
              message.threadRootId === null &&
              message.withdrawnAt !== null,
          )
    if (isWithdrawnRoot)
      stamp.run(newRecordId(), session, resolved.recordId, resolved.source, deliveredAt)
  }
}

function localPendingAcknowledgements(
  session: string,
  beganAt: string | null,
  clock: number,
  database: Database,
  sourceRows = messageRows(database),
): BoardDelivery[] {
  const candidates = sourceRows
    .filter((row) => {
      const receipt = receiptAt(database, 'local', row.record_id, session)
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
      deliveredAt: receiptAt(database, 'local', row.record_id, session).delivered_at,
      purpose: row.purpose ?? 'information',
      text: renderPendingAcknowledgement({
        id: String(row.number),
        author: originText(boardOrigin(row)),
        title: row.title ?? '',
        body: row.body,
        deadline: row.ack_deadline ?? '',
        deliveredAt: receiptAt(database, 'local', row.record_id, session).delivered_at,
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
      const receipt = receiptAt(database, 'hosted', message.id, session)
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
      deliveredAt: receiptAt(database, 'hosted', message.id, session).delivered_at,
      purpose: message.purpose ?? 'information',
      text: renderPendingAcknowledgement({
        id: message.id,
        author: originText(message.origin),
        title: message.title ?? '',
        body: message.body,
        deadline: message.ackDeadline ?? '',
        deliveredAt: receiptAt(database, 'hosted', message.id, session).delivered_at,
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

async function refreshForPendingBoardDelivery(input: DeliveryInput, database: Database) {
  const cachedMode = () =>
    boardMode('shared', input.env ?? process.env, database) === 'local'
      ? ({ status: 'local', applied: 0 } as const)
      : ({ status: 'success', applied: 0 } as const)
  const refreshed = input.refresh
    ? await input.refresh({ budgetMs: input.budgetMs, database })
    : input.budgetMs > 0
      ? await refreshHostedBoard({ budgetMs: input.budgetMs, database })
      : cachedMode()
  if (refreshed.status === 'local' || refreshed.status === 'success')
    return { localMode: refreshed.status === 'local', warning: null }
  return {
    localMode: false,
    warning: hostedBoardStoppedMessage(
      'delivery',
      refreshed,
      HOSTED_BOARD_SIDE_CHANNEL_STOPPED_REMEDY,
    ),
  }
}

function pendingDeliveryCandidates(
  input: DeliveryInput,
  unread: BoardDelivery[],
  withdrawalDeliveries: BoardDelivery[],
  pendingAcknowledgements: BoardDelivery[],
): BoardDelivery[] {
  const recentlyInjected = new Set(input.recentlyInjectedIds ?? [])
  return input.includeAcknowledgementReminders
    ? [
        ...unread,
        ...withdrawalDeliveries,
        ...pendingAcknowledgements.filter(
          (pending) =>
            !unread.some((message) => message.id === pending.id) &&
            !(pending.deliveredAt && recentlyInjected.has(pending.id)),
        ),
      ]
    : [...unread, ...withdrawalDeliveries]
}

export type PendingBoardDelivery = {
  delivery: BoardDelivery[]
  overflow: string | null
  pendingAcknowledgements: BoardDelivery[]
  warning: string | null
  stopped: boolean
}

const unavailableBoardDelivery = (warning: string): PendingBoardDelivery => ({
  delivery: [],
  overflow: null,
  pendingAcknowledgements: [],
  warning,
  stopped: true,
})

async function claimPendingPushes(
  input: DeliveryInput,
  database: Database,
  clock: number,
  localMode: boolean,
  claimReplySuccessors: boolean,
) {
  const env = { CLAUDE_CODE_SESSION_ID: input.session }
  const localRows = localMode ? messageRows(database) : machineMessageRows(database)
  return {
    localRows,
    localPush: claimPushNotices(false, env, clock, database, claimReplySuccessors, localRows),
    hostedPush: localMode
      ? null
      : await claimCachedHostedForPush(input.session, false, clock, database, claimReplySuccessors),
  }
}

export async function pendingBoardDelivery(input: DeliveryInput): Promise<PendingBoardDelivery> {
  requireRealSession(input.session, 'board pending')
  const database = input.database ?? writableDb()
  const clock = input.clock ?? Date.now()
  const refresh = await refreshForPendingBoardDelivery(input, database)
  if (refresh.warning) return unavailableBoardDelivery(refresh.warning)
  const localMode = refresh.localMode
  const beganAt = boardReaderBeganAt(input.session, database)
  const claimReplySuccessors = input.claimReplySuccessors ?? true
  const { localRows, localPush, hostedPush } = await claimPendingPushes(
    input,
    database,
    clock,
    localMode,
    claimReplySuccessors,
  )
  const unread: BoardDelivery[] = [
    ...(localPush?.notices ?? []).map((message) => ({
      id: String(message.number),
      text:
        boardDeliveryForm(message.purpose, 'running') === 'full' ? message.text : message.oneLine,
      requiresAcknowledgement: message.ackRequired,
      createdAt: message.createdAt,
      deliveredAt: null,
      purpose: message.purpose,
    })),
    ...(hostedPush?.notices ?? [])
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
    ...localPendingAcknowledgements(input.session, beganAt, clock, database, localRows),
    ...(localMode ? [] : hostedPendingAcknowledgements(input.session, beganAt, clock, database)),
  ]
  const withdrawals = pendingWithdrawals(
    input.session,
    clock,
    database,
    localMode ? 'local' : 'hosted',
  )
  const withdrawalDeliveries: BoardDelivery[] = withdrawals.map((item) => ({
    id: item.id,
    text: item.text,
    requiresAcknowledgement: item.requiresAcknowledgement,
    createdAt: item.createdAt,
    deliveredAt: item.deliveredAt,
    purpose: item.purpose,
  }))
  const candidates = pendingDeliveryCandidates(
    input,
    unread,
    withdrawalDeliveries,
    pendingAcknowledgements,
  )
  const selected = boundedBoardDelivery(
    input.excludeAcknowledgementRequired
      ? candidates.filter((message) => !message.requiresAcknowledgement)
      : candidates,
  )
  return {
    delivery: selected.messages,
    overflow: selected.overflow,
    pendingAcknowledgements,
    stopped: false,
    warning: deliveryWarning(
      localPush?.warning ?? null,
      hostedPush?.warning ?? null,
      deferredReplySuccessorWarning(
        [
          ...(localPush?.deferredReplySuccessors ?? []),
          ...(hostedPush?.deferredReplySuccessors ?? []),
        ],
        boardPendingCommand(input.session),
      ),
    ),
  }
}

export function boardPendingJson(delivery: PendingBoardDelivery) {
  return {
    delivery: delivery.delivery.map((notice) => ({
      id: notice.id,
      text: notice.text,
      requiresAcknowledgement: notice.requiresAcknowledgement,
    })),
    overflow: delivery.overflow,
    warning: delivery.warning,
    stopped: delivery.stopped,
    pendingAcknowledgements: delivery.pendingAcknowledgements.map((notice) => ({
      id: notice.id,
      text: notice.text,
      requiresAcknowledgement: true,
    })),
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
  env?: Record<string, string | undefined>
}): Promise<void> {
  requireRealSession(input.session, 'board delivery acknowledgement')
  const database = input.database ?? writableDb()
  const clock = input.clock ?? Date.now()
  const deliveredAt = new Date(clock).toISOString()
  if (input.deliveryPoint && !input.emissionId)
    throw new Error('board delivery measurement requires an emission identity')
  const mode = boardMode('shared', input.env ?? process.env, database)
  const messages = localBoardRows(database)
  const withdrawalIds = new Set(input.ids.filter(isWithdrawalDeliveryId))
  const resolved = input.ids.flatMap((id) => {
    if (isWithdrawalDeliveryId(id)) return []
    const identifier = resolveBoardDeliveryIdentifier(database, id, input.env ?? process.env, true)
    if (mode === 'hosted' && (!identifier || identifier.source === 'hosted'))
      boardModeForId(id, 'board delivery id', input.env ?? process.env, database)
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
    stampPendingWithdrawals(database, input.session, withdrawalIds, deliveredAt)
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
       (record_id,message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at,pending_sync)
       VALUES (?,?,?,?,?,NULL,1) ON CONFLICT(message_id,reader_session) DO UPDATE SET
       delivered_at=COALESCE(hosted_board_receipt_cache.delivered_at,excluded.delivered_at),pending_sync=1`,
    )
    for (const row of hosted)
      hostedStamp.run(newRecordId(), row.id, input.session, row.posting ? 1 : 0, deliveredAt)
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

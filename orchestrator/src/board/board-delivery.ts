// concern: board-delivery-seams
/** Refreshes hosted state within each caller's budget, then combines it with local delivery. */

import type { Database } from 'bun:sqlite'
import type { BoardPurpose } from '../../../shared/board-purpose.ts'
import { db, writableDb } from '../database/db.ts'

import {
  BOARD_READ_REFRESH_BUDGET_MS,
  claimCachedHosted,
  claimCachedHostedForPush,
  hostedBoardVerificationWarning,
  markCachedHostedDelivered,
  refreshHostedBoard,
} from './board-hosted-cache.ts'
import {
  HOSTED_BOARD_PRODUCT_STOPPED_REMEDY,
  HOSTED_BOARD_SIDE_CHANNEL_STOPPED_REMEDY,
  hostedBoardStoppedMessage,
} from './board-hosted-refresh-message.ts'
import {
  hostedBoardMessageNotFoundMessage,
  resolveBoardDeliveryIdentifier,
} from './board-message-identifier.ts'
import { architectIdentity, OPERATOR_READER } from './board-policy.ts'
import { boardDeliveryForm } from './board-render.ts'
import {
  claimPushNotices,
  claimRunPushNotices,
  markNoticesDelivered,
  markRunNoticesDelivered,
  markSessionMessagesDelivered,
  readNotices,
  runReaderIdentity,
} from './board-service.ts'

export const BOARD_PUSH_REFRESH_SECONDS = 15
export const BOARD_PUSH_REMIND_SECONDS = 300
export const BOARD_PUSH_RETRY_SECONDS = 15
export const BOARD_PRESENCE_REFRESH_SECONDS = 15
export const BOARD_ACK_STOP_BLOCKS = 3
export const BOARD_PUSH_SLOW_TIMEOUT_SECONDS = (BOARD_READ_REFRESH_BUDGET_MS + 2_000) / 1_000
const BOARD_PROMPT_REFRESH_BUDGET_MS = 750
export const BOARD_ASK_REFRESH_BUDGET_MS = 500

const sessionReader = (env: Record<string, string | undefined>) =>
  architectIdentity(env)?.session ?? OPERATOR_READER

type BoardDeliveryNotice = {
  id: string
  text: string
  oneLine: string
  ackRequired: boolean
  createdAt: string
  purpose?: BoardPurpose
}

const splitBoardIds = (
  sourceIds: Array<string | number>,
  env: Record<string, string | undefined> = process.env,
  database: Database = db(),
) => {
  const local: string[] = []
  const hosted: string[] = []
  for (const sourceId of sourceIds) {
    const resolved = resolveBoardDeliveryIdentifier(database, sourceId, env)
    if (!resolved) continue
    if (resolved.source === 'local') local.push(resolved.recordId)
    else hosted.push(resolved.recordId)
  }
  return { local, hosted }
}

const deliveryNotice = (notice: {
  id?: number | string
  number?: number
  recordId?: string
  text: string
  oneLine: string
  ackRequired: boolean
  createdAt: string
  purpose?: BoardPurpose
}): BoardDeliveryNotice => ({
  id: String(notice.number ?? notice.id ?? notice.recordId),
  text: notice.text,
  oneLine: notice.oneLine,
  ackRequired: notice.ackRequired,
  createdAt: notice.createdAt,
  purpose: notice.purpose,
})

export const deliveryWarning = (...warnings: Array<string | null>): string | null => {
  const unique = [...new Set(warnings.filter((warning): warning is string => warning !== null))]
  return unique.length ? unique.join(' ') : null
}

export async function claimBoardNotices(
  all = false,
  input: {
    env?: Record<string, string | undefined>
    budgetMs?: number
    refresh?: typeof refreshHostedBoard
  } = {},
) {
  const env = input.env ?? process.env
  const refreshed = await (input.refresh ?? refreshHostedBoard)({
    budgetMs: input.budgetMs ?? BOARD_READ_REFRESH_BUDGET_MS,
    env,
  })
  const sessionStartNotice = (notice: ReturnType<typeof deliveryNotice>) => ({
    ...notice,
    text:
      boardDeliveryForm(notice.purpose, 'session-start') === 'full' ? notice.text : notice.oneLine,
  })
  if (refreshed.status === 'local') {
    const local = claimPushNotices(all, env)
    return {
      notices: local.notices.map(deliveryNotice).map(sessionStartNotice),
      warning: local.warning,
      withheldOlderCount: local.withheldOlderCount,
    }
  }
  if (refreshed.status !== 'success')
    throw new Error(
      hostedBoardStoppedMessage('read', refreshed, HOSTED_BOARD_PRODUCT_STOPPED_REMEDY),
    )
  const hosted = await claimCachedHostedForPush(sessionReader(env), all)
  return {
    notices: hosted.notices.map(deliveryNotice).map(sessionStartNotice),
    warning: deliveryWarning(hosted.warning, hostedBoardVerificationWarning()),
    withheldOlderCount: hosted.withheldOlderCount,
  }
}

export async function readBoardNotices(
  all = false,
  input: {
    env?: Record<string, string | undefined>
    budgetMs?: number
    refresh?: typeof refreshHostedBoard
  } = {},
) {
  const env = input.env ?? process.env
  const refreshed = await (input.refresh ?? refreshHostedBoard)({
    budgetMs: input.budgetMs ?? BOARD_READ_REFRESH_BUDGET_MS,
    env,
  })
  if (refreshed.status === 'local')
    return { notices: readNotices(all, env).map(deliveryNotice), warning: null }
  if (refreshed.status !== 'success')
    throw new Error(
      hostedBoardStoppedMessage('read', refreshed, HOSTED_BOARD_PRODUCT_STOPPED_REMEDY),
    )
  const hosted = claimCachedHosted(sessionReader(env), all)
  await markCachedHostedDelivered(
    sessionReader(env),
    hosted.map((notice) => notice.id),
  )
  return {
    notices: hosted.map(deliveryNotice),
    warning: hostedBoardVerificationWarning(),
  }
}

export async function claimRunBoardNotices(
  runId: string,
  all = false,
  budgetMs = BOARD_PROMPT_REFRESH_BUDGET_MS,
  sessionStart = false,
  refresh: typeof refreshHostedBoard = refreshHostedBoard,
) {
  const runNotice = (notice: ReturnType<typeof deliveryNotice>) => ({
    ...notice,
    text:
      boardDeliveryForm(notice.purpose, sessionStart ? 'session-start' : 'running') === 'full'
        ? notice.text
        : notice.oneLine,
  })
  const refreshed = await refresh({ budgetMs })
  const { reader, readerRunRecordId } = runReaderIdentity(runId)
  if (refreshed.status === 'local') {
    const local = claimRunPushNotices(runId, all)
    return {
      notices: local.notices.map(deliveryNotice).map(runNotice),
      warning: local.warning,
      withheldOlderCount: local.withheldOlderCount,
    }
  }
  if (refreshed.status === 'success') {
    const hosted = await claimCachedHostedForPush(
      reader,
      all,
      Date.now(),
      undefined,
      true,
      readerRunRecordId,
    )
    return {
      notices: hosted.notices.map(deliveryNotice).map(runNotice),
      warning: deliveryWarning(hosted.warning, hostedBoardVerificationWarning()),
      withheldOlderCount: hosted.withheldOlderCount,
    }
  }
  return {
    notices: [],
    warning: hostedBoardStoppedMessage('read', refreshed, HOSTED_BOARD_SIDE_CHANNEL_STOPPED_REMEDY),
    withheldOlderCount: 0,
  }
}

export async function markRunBoardNoticesDelivered(
  runId: string,
  sourceIds: Array<string | number>,
): Promise<void> {
  const ids = splitBoardIds(sourceIds)
  const { reader, readerRunRecordId } = runReaderIdentity(runId)
  if (ids.local.length) markRunNoticesDelivered(runId, ids.local)
  if (ids.hosted.length) await markCachedHostedDelivered(reader, ids.hosted, { readerRunRecordId })
}

export async function markBoardNoticesDelivered(
  sourceIds: Array<string | number>,
  env: Record<string, string | undefined> = process.env,
  input: {
    database?: Database
    refresh?: typeof refreshHostedBoard
  } = {},
): Promise<void> {
  const database = input.database ?? writableDb()
  const ids = splitBoardIds(sourceIds, env, database)
  if (ids.hosted.length) {
    const refreshed = await (input.refresh ?? refreshHostedBoard)({
      budgetMs: BOARD_READ_REFRESH_BUDGET_MS,
      env,
      database,
    })
    if (refreshed.status !== 'success')
      throw new Error(
        hostedBoardStoppedMessage('read', refreshed, HOSTED_BOARD_PRODUCT_STOPPED_REMEDY),
      )
    for (const id of ids.hosted) {
      const cached = database
        .query('SELECT 1 FROM hosted_board_message_cache WHERE id=? LIMIT 1')
        .get(id)
      if (!cached) throw new Error(hostedBoardMessageNotFoundMessage(id))
    }
  }
  if (ids.local.length) markNoticesDelivered(ids.local, env, Date.now(), database)
  if (ids.hosted.length)
    await markCachedHostedDelivered(sessionReader(env), ids.hosted, { database })
}

export async function markBoardDeliveriesDelivered(
  ownerSession: string,
  ids: string[],
  deliveredAt: string,
): Promise<void> {
  const split = splitBoardIds(ids)
  markSessionMessagesDelivered(ownerSession, split.local, deliveredAt)
  if (split.hosted.length)
    await markCachedHostedDelivered(ownerSession, split.hosted, {
      clock: Date.parse(deliveredAt),
    })
}

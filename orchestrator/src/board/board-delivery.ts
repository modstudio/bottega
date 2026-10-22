// concern: board-delivery-seams
/** Refreshes hosted state within each caller's budget, then combines it with local delivery. */

import type { BoardPurpose } from '../../../shared/board-purpose.ts'
import { db } from '../database/db.ts'

import {
  claimCachedHosted,
  claimCachedHostedForPush,
  hostedBoardVerificationWarning,
  markCachedHostedDelivered,
  refreshHostedBoard,
} from './board-hosted-cache.ts'
import { resolveBoardDeliveryIdentifier } from './board-message-identifier.ts'
import { architectIdentity, OPERATOR_READER } from './board-policy.ts'
import { boardDeliveryForm } from './board-render.ts'
import {
  claimPushNotices,
  claimRunPushNotices,
  markNoticesDelivered,
  markRunNoticesDelivered,
  markSessionMessagesDelivered,
  readNotices,
  runReader,
} from './board-service.ts'

export const BOARD_READ_REFRESH_BUDGET_MS = 500
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
) => {
  const local: string[] = []
  const hosted: string[] = []
  for (const sourceId of sourceIds) {
    const resolved = resolveBoardDeliveryIdentifier(db(), sourceId, env)
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

const deliveryWarning = (...warnings: Array<string | null>): string | null => {
  const unique = [...new Set(warnings.filter((warning): warning is string => warning !== null))]
  return unique.length ? unique.join(' ') : null
}

export async function claimBoardNotices(
  all = false,
  input: { env?: Record<string, string | undefined>; budgetMs?: number } = {},
) {
  const env = input.env ?? process.env
  const refreshed = await refreshHostedBoard({
    budgetMs: input.budgetMs ?? BOARD_READ_REFRESH_BUDGET_MS,
    env,
  })
  const local = claimPushNotices(all, env)
  const sessionStartNotice = (notice: ReturnType<typeof deliveryNotice>) => ({
    ...notice,
    text:
      boardDeliveryForm(notice.purpose, 'session-start') === 'full' ? notice.text : notice.oneLine,
  })
  if (refreshed.status === 'local')
    return {
      notices: local.notices.map(deliveryNotice).map(sessionStartNotice),
      warning: local.warning,
      withheldOlderCount: local.withheldOlderCount,
    }
  const hosted = claimCachedHostedForPush(sessionReader(env), all)
  return {
    notices: [
      ...local.notices.map(deliveryNotice).map(sessionStartNotice),
      ...hosted.notices.map(deliveryNotice).map(sessionStartNotice),
    ],
    warning: deliveryWarning(local.warning, hosted.warning, hostedBoardVerificationWarning()),
    withheldOlderCount: local.withheldOlderCount + hosted.withheldOlderCount,
  }
}

export async function readBoardNotices(
  all = false,
  input: { env?: Record<string, string | undefined>; budgetMs?: number } = {},
) {
  const env = input.env ?? process.env
  const refreshed = await refreshHostedBoard({
    budgetMs: input.budgetMs ?? BOARD_READ_REFRESH_BUDGET_MS,
    env,
  })
  const local = readNotices(all, env).map(deliveryNotice)
  if (refreshed.status === 'local') return { notices: local, warning: null }
  const hosted = claimCachedHosted(sessionReader(env), all)
  await markCachedHostedDelivered(
    sessionReader(env),
    hosted.map((notice) => notice.id),
  )
  return {
    notices: [...local, ...hosted.map(deliveryNotice)],
    warning: hostedBoardVerificationWarning(),
  }
}

export async function claimRunBoardNotices(
  runId: string,
  all = false,
  budgetMs = BOARD_PROMPT_REFRESH_BUDGET_MS,
  sessionStart = false,
) {
  const runNotice = (notice: ReturnType<typeof deliveryNotice>) => ({
    ...notice,
    text:
      boardDeliveryForm(notice.purpose, sessionStart ? 'session-start' : 'running') === 'full'
        ? notice.text
        : notice.oneLine,
  })
  const refreshed = await refreshHostedBoard({ budgetMs })
  const reader = runReader(runId)
  const local = claimRunPushNotices(runId, all)
  if (refreshed.status === 'local')
    return {
      notices: local.notices.map(deliveryNotice).map(runNotice),
      warning: local.warning,
      withheldOlderCount: local.withheldOlderCount,
    }
  const hosted = claimCachedHostedForPush(reader, all)
  return {
    notices: [...local.notices.map(deliveryNotice), ...hosted.notices.map(deliveryNotice)].map(
      runNotice,
    ),
    warning: deliveryWarning(local.warning, hosted.warning, hostedBoardVerificationWarning()),
    withheldOlderCount: local.withheldOlderCount + hosted.withheldOlderCount,
  }
}

export async function markRunBoardNoticesDelivered(
  runId: string,
  sourceIds: Array<string | number>,
): Promise<void> {
  const ids = splitBoardIds(sourceIds)
  const reader = runReader(runId)
  markRunNoticesDelivered(runId, ids.local)
  if (ids.hosted.length) await markCachedHostedDelivered(reader, ids.hosted)
}

export async function markBoardNoticesDelivered(
  sourceIds: Array<string | number>,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const ids = splitBoardIds(sourceIds, env)
  markNoticesDelivered(ids.local, env)
  if (ids.hosted.length) await markCachedHostedDelivered(sessionReader(env), ids.hosted)
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

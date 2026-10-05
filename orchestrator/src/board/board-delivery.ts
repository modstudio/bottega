// concern: board-delivery-seams
/** Refreshes hosted state within each caller's budget, then combines it with local delivery. */

import {
  claimCachedHosted,
  claimCachedHostedInterrupts,
  hostedBoardVerificationWarning,
  markCachedHostedDelivered,
  refreshHostedBoard,
  takeHostedBoardVerificationTransition,
} from './board-hosted-cache.ts'
import { architectIdentity, OPERATOR_READER } from './board-policy.ts'
import {
  claimInterruptNotices,
  claimNotices,
  claimRunNotices,
  markInterruptNoticesDelivered,
  markNoticesDelivered,
  markRunNoticesDelivered,
  readNotices,
  runReader,
} from './board-service.ts'

const BOARD_READ_REFRESH_BUDGET_MS = 500
const BOARD_MONITOR_REFRESH_BUDGET_MS = 500
const BOARD_PROMPT_REFRESH_BUDGET_MS = 750
export const BOARD_ASK_REFRESH_BUDGET_MS = 500

const sessionReader = (env: Record<string, string | undefined>) =>
  architectIdentity(env)?.session ?? OPERATOR_READER

type BoardDeliveryNotice = {
  id: string
  text: string
  ackRequired: boolean
  createdAt: string
}

const deliveryNotice = (notice: {
  id: number | string
  text: string
  ackRequired: boolean
  createdAt: string
}): BoardDeliveryNotice => ({ ...notice, id: String(notice.id) })

export async function claimBoardNotices(
  all = false,
  input: { env?: Record<string, string | undefined>; budgetMs?: number } = {},
) {
  const env = input.env ?? process.env
  const refreshed = await refreshHostedBoard({
    budgetMs: input.budgetMs ?? BOARD_READ_REFRESH_BUDGET_MS,
    env,
  })
  return refreshed === 'local'
    ? { notices: claimNotices(all, env).map(deliveryNotice), warning: null }
    : {
        notices: [
          ...claimNotices(all, env).map(deliveryNotice),
          ...claimCachedHosted(sessionReader(env), all).map(deliveryNotice),
        ],
        warning: hostedBoardVerificationWarning(),
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
  if (refreshed === 'local') return { notices: local, warning: null }
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
  runId: number,
  all = false,
  budgetMs = BOARD_PROMPT_REFRESH_BUDGET_MS,
) {
  const refreshed = await refreshHostedBoard({ budgetMs })
  const reader = runReader(runId)
  return refreshed === 'local'
    ? { notices: claimRunNotices(runId, all).map(deliveryNotice), warning: null }
    : {
        notices: [
          ...claimRunNotices(runId, all).map(deliveryNotice),
          ...claimCachedHosted(reader, all).map(deliveryNotice),
        ],
        warning: hostedBoardVerificationWarning(),
      }
}

export async function markRunBoardNoticesDelivered(
  runId: number,
  sourceIds: Array<string | number>,
): Promise<void> {
  const ids = sourceIds.map(String)
  const reader = runReader(runId)
  markRunNoticesDelivered(runId, ids.filter((id) => /^[1-9]\d*$/.test(id)).map(Number))
  await markCachedHostedDelivered(
    reader,
    ids.filter((id) => !/^[1-9]\d*$/.test(id)),
  )
}

export async function markBoardNoticesDelivered(
  sourceIds: Array<string | number>,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const ids = sourceIds.map(String)
  markNoticesDelivered(ids.filter((id) => /^[1-9]\d*$/.test(id)).map(Number), env)
  await markCachedHostedDelivered(
    sessionReader(env),
    ids.filter((id) => !/^[1-9]\d*$/.test(id)),
  )
}

export async function claimBoardInterrupts(
  ownerSession: string,
  input: { refresh?: boolean } = {},
): Promise<{
  notices: Array<{ noticeId: `board:${string}`; detail: string }>
  warning: string | null
}> {
  const refreshed =
    input.refresh === false
      ? 'success'
      : await refreshHostedBoard({ budgetMs: BOARD_MONITOR_REFRESH_BUDGET_MS })
  const local = claimInterruptNotices(ownerSession)
  if (refreshed === 'local') return { notices: local, warning: null }
  return {
    notices: [...local, ...claimCachedHostedInterrupts(ownerSession)],
    warning:
      input.refresh === false
        ? hostedBoardVerificationWarning()
        : takeHostedBoardVerificationTransition(),
  }
}

export async function markBoardInterruptsDelivered(
  ownerSession: string,
  ids: string[],
  deliveredAt: string,
): Promise<void> {
  const local = ids.filter((id) => /^[1-9]\d*$/.test(id)).map(Number)
  markInterruptNoticesDelivered(ownerSession, local, deliveredAt)
  await markCachedHostedDelivered(
    ownerSession,
    ids.filter((id) => !/^[1-9]\d*$/.test(id)),
    { clock: Date.parse(deliveredAt) },
  )
}

// concern: board-delivery-seams
/** Refreshes hosted state within each caller's budget, then combines it with local delivery. */

import {
  claimCachedHosted,
  hostedBoardVerificationWarning,
  markCachedHostedDelivered,
  refreshHostedBoard,
} from './board-hosted-cache.ts'
import { architectIdentity, OPERATOR_READER } from './board-policy.ts'
import {
  claimNotices,
  claimRunNotices,
  markNoticesDelivered,
  markRunNoticesDelivered,
  readNotices,
  runReader,
} from './board-service.ts'

const BOARD_READ_REFRESH_BUDGET_MS = 500
export const BOARD_MONITOR_REFRESH_BUDGET_MS = 500
const BOARD_PROMPT_REFRESH_BUDGET_MS = 750
export const BOARD_ASK_REFRESH_BUDGET_MS = 500

const sessionReader = (env: Record<string, string | undefined>) =>
  architectIdentity(env)?.session ?? OPERATOR_READER

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
    ? { notices: claimNotices(all, env), warning: null }
    : {
        notices: [...claimNotices(all, env), ...claimCachedHosted(sessionReader(env), all)],
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
  const local = readNotices(all, env)
  if (refreshed === 'local') return { notices: local, warning: null }
  const hosted = claimCachedHosted(sessionReader(env), all)
  await markCachedHostedDelivered(
    sessionReader(env),
    hosted.map((notice) => notice.id),
  )
  return { notices: [...local, ...hosted], warning: hostedBoardVerificationWarning() }
}

export async function claimRunBoardNotices(
  runId: number,
  all = false,
  budgetMs = BOARD_PROMPT_REFRESH_BUDGET_MS,
) {
  const refreshed = await refreshHostedBoard({ budgetMs })
  const reader = runReader(runId)
  return refreshed === 'local'
    ? { notices: claimRunNotices(runId, all), warning: null }
    : {
        notices: [...claimRunNotices(runId, all), ...claimCachedHosted(reader, all)],
        warning: hostedBoardVerificationWarning(),
      }
}

export async function markRunBoardNoticesDelivered(
  runId: number,
  ids: Array<number | string>,
): Promise<void> {
  const reader = runReader(runId)
  markRunNoticesDelivered(
    runId,
    ids.filter((id): id is number => typeof id === 'number'),
  )
  await markCachedHostedDelivered(
    reader,
    ids.filter((id): id is string => typeof id === 'string'),
  )
}

export async function markBoardNoticesDelivered(
  ids: Array<number | string>,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  markNoticesDelivered(
    ids.filter((id): id is number => typeof id === 'number'),
    env,
  )
  await markCachedHostedDelivered(
    sessionReader(env),
    ids.filter((id): id is string => typeof id === 'string'),
  )
}

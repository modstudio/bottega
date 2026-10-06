// concern: board-overview
/** Builds the operator's side-effect-free overview from local and hosted-cache roots. */
import { db } from '../database/db.ts'
import type { RecordApiClient } from '../record/record-api-client.ts'
import type { HostedBoardMessage } from '../record/record-board-contract.ts'
import { BOARD_READ_REFRESH_BUDGET_MS } from './board-delivery.ts'
import {
  cachedHostedBoardMessages,
  hostedBoardVerificationWarning,
  hostedMessageIsLive,
  refreshHostedBoard,
} from './board-hosted-cache.ts'
import { type BoardStatusResult, boardStatus, hostedBoardStatusResult } from './board-operations.ts'
import { type BoardOrigin, messageRows, rowIsLive } from './board-store.ts'
import { type BoardThreadState, boardThreadState } from './board-thread-policy.ts'

type BoardKind = 'notice' | 'question'

export type BoardOverviewFilters = {
  kind?: BoardKind
  open?: boolean
  includeEnded?: boolean
}

type BoardOverviewBase = {
  id: string
  kind: BoardKind
  title: string | null
  audience: string | null
  origin: BoardOrigin
  senderTags: { kind: 'task' | 'path' | 'topic'; value: string }[]
  createdAt: string
  expiresAt: string | null
  withdrawnAt: string | null
  ackRequired: boolean
  ackDeadline: string | null
  state: BoardThreadState
  reached: number | null
  acknowledged: number | null
  unacknowledged: string[] | null
  store: 'local' | 'hosted'
}

export type BoardOverviewEntry =
  | (BoardOverviewBase & { kind: 'notice' })
  | (BoardOverviewBase & {
      kind: 'question'
      replyCount: number
      acceptedReplyId: string | null
    })

export type GatheredBoardOverviewRow = { message: BoardOverviewEntry; ended: boolean }

export function boardOverview(
  rows: GatheredBoardOverviewRow[],
  filters: BoardOverviewFilters = {},
): BoardOverviewEntry[] {
  return rows
    .filter((row) => !filters.kind || row.message.kind === filters.kind)
    .filter(
      (row) =>
        !filters.open || (row.message.kind === 'question' && row.message.acceptedReplyId === null),
    )
    .filter((row) => filters.includeEnded || !row.ended)
    .map((row) => row.message)
    .toSorted(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    )
}

function statusEntry(
  status: BoardStatusResult,
  replyCount: number,
  store: 'local' | 'hosted',
): BoardOverviewEntry | null {
  const message = status.message
  if (message.kind !== 'notice' && message.kind !== 'question') return null
  const required = {
    title: message.title,
    origin: message.origin,
    senderTags: message.senderTags,
    createdAt: message.createdAt,
    ackRequired: message.ackRequired,
    state: message.state,
  }
  for (const [field, value] of Object.entries(required)) {
    if (value === null) throw new Error(`board message ${message.id} is missing ${field}`)
  }
  const base: BoardOverviewBase = {
    id: message.id,
    kind: message.kind,
    title: message.title as string,
    audience: message.audience,
    origin: message.origin as BoardOrigin,
    senderTags: message.senderTags as BoardOverviewBase['senderTags'],
    createdAt: message.createdAt as string,
    expiresAt: message.expiresAt,
    withdrawnAt: message.withdrawnAt,
    ackRequired: message.ackRequired as boolean,
    ackDeadline: message.ackDeadline,
    state: message.state as BoardThreadState,
    reached: status.reached,
    acknowledged: status.acknowledged,
    unacknowledged: status.unacknowledged,
    store,
  }
  return message.kind === 'question'
    ? {
        ...base,
        kind: 'question',
        replyCount,
        acceptedReplyId: message.acceptedReplyId,
      }
    : { ...base, kind: 'notice' }
}

async function localEntries(clock: number): Promise<GatheredBoardOverviewRow[]> {
  const roots = messageRows().filter(
    (row) => row.thread_root_id === null && (row.kind === 'notice' || row.kind === 'question'),
  )
  const replyCounts = new Map<number, number>()
  for (const row of messageRows()) {
    if (row.kind !== 'reply' || row.thread_root_id === null) continue
    replyCounts.set(row.thread_root_id, (replyCounts.get(row.thread_root_id) ?? 0) + 1)
  }
  const entries = await Promise.all(
    roots.map(async (row) => ({
      message: statusEntry(
        await boardStatus(String(row.id), { env: {}, clock }),
        replyCounts.get(row.id) ?? 0,
        'local',
      ),
      ended: !rowIsLive(row, clock),
    })),
  )
  return entries.filter((row) => row.message !== null) as GatheredBoardOverviewRow[]
}

function hostedEntries(messages: HostedBoardMessage[], clock: number): GatheredBoardOverviewRow[] {
  const replies = new Map<string, number>()
  for (const message of messages) {
    if (message.kind !== 'reply' || message.threadRootId === null) continue
    replies.set(message.threadRootId, (replies.get(message.threadRootId) ?? 0) + 1)
  }
  return messages
    .filter((message) => message.threadRootId === null)
    .map((message) => {
      const current = {
        ...message,
        state: boardThreadState({
          acceptedReplyId: message.acceptedReplyId,
          withdrawnAt: message.withdrawnAt,
          expiresAt: message.expiresAt,
          clock,
        }),
      }
      return {
        message: statusEntry(
          hostedBoardStatusResult(current),
          replies.get(message.id) ?? 0,
          'hosted',
        ),
        ended: !hostedMessageIsLive(message, clock),
      }
    })
    .filter((row) => row.message !== null) as GatheredBoardOverviewRow[]
}

export async function listBoardOverview(
  filters: BoardOverviewFilters = {},
  input: {
    env?: Record<string, string | undefined>
    clock?: number
    budgetMs?: number
    client?: RecordApiClient
  } = {},
): Promise<{ messages: BoardOverviewEntry[]; warning: string | null }> {
  const clock = input.clock ?? Date.now()
  const refreshed = await refreshHostedBoard({
    budgetMs: input.budgetMs ?? BOARD_READ_REFRESH_BUDGET_MS,
    env: input.env,
    client: input.client,
  })
  const rows = await localEntries(clock)
  if (refreshed !== 'local') rows.push(...hostedEntries(cachedHostedBoardMessages(db()), clock))
  return {
    messages: boardOverview(rows, filters),
    warning: refreshed === 'local' ? null : hostedBoardVerificationWarning(),
  }
}

// concern: record-board-overview
/** Lists hosted board roots visible through tenant policy. Must not know HTTP or local stores. */

import type { SQL } from 'bun'
import type { BoardTag } from '../board/board-tags.ts'
import {
  BOARD_MESSAGES_PAGE_LIMIT,
  type HostedBoardMessage,
  type HostedBoardOverview,
  type HostedBoardOverviewEntry,
  type HostedBoardOverviewFilters,
  type HostedBoardReceipt,
} from './record-board-contract.ts'
import { hostedBoardMessageView, hostedBoardTags } from './record-board-messages.ts'
import { hostedBoardReceiptView } from './record-board-receipts.ts'
import { type BoardTenant, boardUuidArray, withBoardTenant } from './record-board-tx.ts'

function groupTags(rows: Record<string, unknown>[]): Map<string, BoardTag[]> {
  const result = new Map<string, BoardTag[]>()
  for (const row of rows) {
    const id = String(row.message_id)
    const tags = result.get(id) ?? []
    tags.push(...hostedBoardTags([row]))
    result.set(id, tags)
  }
  return result
}

function groupReceipts(rows: Record<string, unknown>[]): Map<string, HostedBoardReceipt[]> {
  const result = new Map<string, HostedBoardReceipt[]>()
  for (const row of rows) {
    const id = String(row.message_id)
    const receipts = result.get(id) ?? []
    receipts.push(hostedBoardReceiptView(row))
    result.set(id, receipts)
  }
  return result
}

export function hostedBoardOverviewEntry(
  message: HostedBoardMessage,
  replyCount: number,
  receipts: HostedBoardReceipt[],
  userId: string,
): HostedBoardOverviewEntry {
  if (message.kind !== 'notice' && message.kind !== 'question') {
    throw new Error(`board overview message ${message.id} is not a root`)
  }
  const state = message.state
  if (state !== 'open' && state !== 'accepted' && state !== 'withdrawn' && state !== 'expired') {
    throw new Error(`board overview message ${message.id} has no root state`)
  }
  const authored = message.authorUserId === userId
  const base = {
    id: message.id,
    kind: message.kind,
    title: message.title,
    audience: message.audience,
    origin: message.origin,
    senderTags: message.senderTags,
    createdAt: message.createdAt,
    expiresAt: message.expiresAt,
    withdrawnAt: message.withdrawnAt,
    ackRequired: message.ackRequired,
    ackDeadline: message.ackDeadline,
    state: state as HostedBoardOverviewEntry['state'],
    reached: authored ? receipts.length : null,
    acknowledged: authored
      ? receipts.filter((receipt) => receipt.acknowledgedAt !== null).length
      : null,
    unacknowledged: authored
      ? message.ackRequired
        ? receipts
            .filter((receipt) => receipt.acknowledgedAt === null)
            .map((receipt) => receipt.readerSession)
        : []
      : null,
    store: 'hosted' as const,
  }
  return message.kind === 'question'
    ? { ...base, kind: 'question', replyCount, acceptedReplyId: message.acceptedReplyId }
    : { ...base, kind: 'notice' }
}

async function relatedRows(tx: SQL, ids: string[]) {
  const uuidIds = boardUuidArray(tx, ids)
  const replyRows = await tx`
    SELECT thread_root_id, COUNT(*)::int AS reply_count FROM board_message
    WHERE kind='reply'
      AND thread_root_id = ANY(COALESCE(${uuidIds}, ARRAY[]::uuid[]))
    GROUP BY thread_root_id
  `
  const receiptRows = await tx`
    SELECT * FROM board_receipt
    WHERE message_id = ANY(COALESCE(${boardUuidArray(tx, ids)}, ARRAY[]::uuid[]))
    ORDER BY reader_user_id, reader_session
  `
  const tagRows = await tx`
    SELECT message_id, kind, value, origin FROM board_message_tag
    WHERE message_id = ANY(COALESCE(${boardUuidArray(tx, ids)}, ARRAY[]::uuid[]))
    ORDER BY kind, value, origin
  `
  return {
    replyCounts: new Map(
      (replyRows as Record<string, unknown>[]).map((row) => [
        String(row.thread_root_id),
        Number(row.reply_count),
      ]),
    ),
    receipts: groupReceipts(receiptRows as Record<string, unknown>[]),
    tags: groupTags(tagRows as Record<string, unknown>[]),
  }
}

export async function listHostedBoardOverview(
  input: BoardTenant & HostedBoardOverviewFilters,
): Promise<HostedBoardOverview> {
  const clock = Date.now()
  const now = new Date(clock).toISOString()
  return withBoardTenant(input, false, async (tx) => {
    const rows = (await tx`
      SELECT * FROM board_message
      WHERE thread_root_id IS NULL
        AND kind IN ('notice', 'question')
        AND (${input.kind ?? null}::text IS NULL OR kind=${input.kind ?? null})
        AND (${input.open ?? false}::boolean=FALSE
          OR (kind='question' AND accepted_reply_id IS NULL))
        AND (${input.includeEnded ?? false}::boolean=TRUE
          OR (withdrawn_at IS NULL AND expires_at>${now}::timestamptz))
      ORDER BY created_at DESC, id DESC
      LIMIT ${BOARD_MESSAGES_PAGE_LIMIT + 1}
    `) as Record<string, unknown>[]
    const truncated = rows.length > BOARD_MESSAGES_PAGE_LIMIT
    const roots = rows.slice(0, BOARD_MESSAGES_PAGE_LIMIT)
    if (roots.length === 0) return { messages: [], truncated }
    const ids = roots.map((row) => String(row.id))
    const related = await relatedRows(tx, ids)
    return {
      messages: roots.map((row) => {
        const id = String(row.id)
        return hostedBoardOverviewEntry(
          hostedBoardMessageView(row, related.tags.get(id) ?? [], clock),
          related.replyCounts.get(id) ?? 0,
          related.receipts.get(id) ?? [],
          input.userId,
        )
      }),
      truncated,
    }
  })
}

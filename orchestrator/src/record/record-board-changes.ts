// concern: record-board-changes
/** Owns the hosted board change cursor. Must not know HTTP or local stores. */

import type { BoardTag } from '../board/board-tags.ts'
import {
  BOARD_CHANGES_PAGE_LIMIT,
  type HostedBoardChange,
  type HostedBoardChanges,
  RecordBoardError,
} from './record-board-contract.ts'
import { hostedBoardMessageView, hostedBoardTags } from './record-board-messages.ts'
import { hostedBoardReceiptView } from './record-board-receipts.ts'
import { type BoardTenant, boardUuidArray, withBoardTenant } from './record-board-tx.ts'

export async function listHostedBoardChanges(
  input: BoardTenant & { after: string; limit?: number },
): Promise<HostedBoardChanges> {
  if (!/^\d+$/.test(input.after)) {
    throw new RecordBoardError('board changes after must be a non-negative integer revision', 400)
  }
  const limit = input.limit ?? BOARD_CHANGES_PAGE_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > BOARD_CHANGES_PAGE_LIMIT) {
    throw new RecordBoardError(
      `board changes limit must be between 1 and ${BOARD_CHANGES_PAGE_LIMIT}`,
      400,
    )
  }
  const clock = Date.now()
  return withBoardTenant(input, false, async (tx) => {
    const messages = (await tx`
      SELECT * FROM board_message
      WHERE revision > ${input.after}::bigint
      ORDER BY revision
      LIMIT ${limit}
    `) as Record<string, unknown>[]
    if (messages.length === 0) return { userId: input.userId, items: [], highestRevision: null }
    const ids = messages.map((row) => String(row.id))
    const tagRows = (await tx`
      SELECT message_id, kind, value, origin FROM board_message_tag
      WHERE message_id = ANY(COALESCE(${boardUuidArray(tx, ids)}, ARRAY[]::uuid[]))
      ORDER BY kind, value, origin
    `) as Record<string, unknown>[]
    const receiptRows = (await tx`
      SELECT * FROM board_receipt
      WHERE reader_user_id=${input.userId}::uuid
        AND message_id = ANY(COALESCE(${boardUuidArray(tx, ids)}, ARRAY[]::uuid[]))
    `) as Record<string, unknown>[]
    const tagsByMessage = new Map<string, BoardTag[]>()
    for (const row of tagRows) {
      const id = String(row.message_id)
      const list = tagsByMessage.get(id) ?? []
      list.push(...hostedBoardTags([row]))
      tagsByMessage.set(id, list)
    }
    const receiptsByMessage = new Map<string, HostedBoardChange['receipts']>()
    for (const row of receiptRows) {
      const id = String(row.message_id)
      const list = receiptsByMessage.get(id) ?? []
      list.push(hostedBoardReceiptView(row))
      receiptsByMessage.set(id, list)
    }
    const items = messages.map((row) => {
      const id = String(row.id)
      const tags = tagsByMessage.get(id) ?? []
      return {
        message: hostedBoardMessageView(row, tags, clock),
        tags,
        receipts: receiptsByMessage.get(id) ?? [],
      }
    })
    return {
      userId: input.userId,
      items,
      highestRevision: items.at(-1)?.message.revision ?? null,
    }
  })
}

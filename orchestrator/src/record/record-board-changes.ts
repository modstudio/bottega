// concern: record-board-changes
/** Owns the hosted board change cursor. Must not know HTTP or local stores. */

import type { BoardTag } from '../board/board-tags.ts'
import {
  BOARD_CHANGES_PAGE_LIMIT,
  type HostedBoardChange,
  RecordBoardError,
} from './record-board-contract.ts'
import { hostedBoardMessageView } from './record-board-messages.ts'
import { type BoardTenant, withBoardTenant } from './record-board-tx.ts'

const iso = (value: unknown) => (value == null ? null : new Date(String(value)).toISOString())

export async function listHostedBoardChanges(
  input: BoardTenant & { after: string; limit?: number },
): Promise<{ items: HostedBoardChange[]; highestRevision: string | null }> {
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
    if (messages.length === 0) return { items: [], highestRevision: null }
    const ids = messages.map((row) => String(row.id))
    const tagRows = (await tx`
      SELECT message_id, kind, value, origin FROM board_message_tag
      WHERE message_id = ANY(COALESCE(string_to_array(nullif(${ids.join(',')}, ''), ',')::uuid[], ARRAY[]::uuid[]))
      ORDER BY kind, value, origin
    `) as Record<string, unknown>[]
    const receiptRows = (await tx`
      SELECT * FROM board_receipt
      WHERE reader_user_id=${input.userId}::uuid
        AND message_id = ANY(COALESCE(string_to_array(nullif(${ids.join(',')}, ''), ',')::uuid[], ARRAY[]::uuid[]))
    `) as Record<string, unknown>[]
    const tagsByMessage = new Map<string, BoardTag[]>()
    for (const row of tagRows) {
      const id = String(row.message_id)
      const list = tagsByMessage.get(id) ?? []
      list.push({
        kind: String(row.kind) as BoardTag['kind'],
        value: String(row.value),
        origin: String(row.origin) as BoardTag['origin'],
      })
      tagsByMessage.set(id, list)
    }
    const receiptsByMessage = new Map<string, HostedBoardChange['receipts']>()
    for (const row of receiptRows) {
      const id = String(row.message_id)
      const list = receiptsByMessage.get(id) ?? []
      list.push({
        messageId: id,
        readerUserId: String(row.reader_user_id),
        readerSession: String(row.reader_session),
        audienceAtPosting: Boolean(row.audience_at_posting),
        deliveredAt: iso(row.delivered_at),
        acknowledgedAt: iso(row.acknowledged_at),
      })
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
      items,
      highestRevision: items.at(-1)?.message.revision ?? null,
    }
  })
}

// concern: record-board-receipts
/** Owns hosted board receipt writes. Must not know HTTP or local stores. */

import {
  type HostedBoardReceipt,
  type HostedBoardReceiptInput,
  type HostedBoardStatus,
  RecordBoardError,
} from './record-board-contract.ts'
import { hostedBoardMessageView, loadHostedBoardMessage } from './record-board-messages.ts'
import { type BoardTenant, withBoardTenant } from './record-board-tx.ts'

const iso = (value: unknown) => (value == null ? null : new Date(String(value)).toISOString())

export function hostedBoardReceiptView(row: Record<string, unknown>): HostedBoardReceipt {
  return {
    messageId: String(row.message_id),
    readerUserId: String(row.reader_user_id),
    readerSession: String(row.reader_session),
    audienceAtPosting: Boolean(row.audience_at_posting),
    deliveredAt: iso(row.delivered_at),
    acknowledgedAt: iso(row.acknowledged_at),
  }
}

export async function hostedBoardStatus(
  input: BoardTenant & { id: string },
): Promise<HostedBoardStatus> {
  return withBoardTenant(input, false, async (tx) => {
    const message = await loadHostedBoardMessage(tx, input.id)
    if (!message) throw new RecordBoardError(`board message ${input.id} not found`, 404)
    const rows = (await tx`
      SELECT * FROM board_receipt
      WHERE message_id=${input.id}::uuid
      ORDER BY reader_user_id, reader_session
    `) as Record<string, unknown>[]
    return {
      message: hostedBoardMessageView(message.row, message.tags),
      receipts: rows.map(hostedBoardReceiptView),
    }
  })
}

export async function putHostedBoardReceipt(
  input: BoardTenant & HostedBoardReceiptInput,
): Promise<HostedBoardReceipt> {
  if (!input.readerSession.trim()) {
    throw new RecordBoardError('board receipt requires readerSession', 400)
  }
  if (!input.delivered && !input.acknowledged) {
    throw new RecordBoardError('board receipt requires delivered or acknowledged', 400)
  }
  const clock = new Date().toISOString()
  return withBoardTenant(input, false, async (tx) => {
    const message = await loadHostedBoardMessage(tx, input.messageId)
    if (!message) throw new RecordBoardError(`board message ${input.messageId} not found`, 404)
    const deliveredAt = input.delivered ? clock : null
    const acknowledgedAt = input.acknowledged ? clock : null
    const rows = await tx`
      INSERT INTO board_receipt (
        message_id, reader_user_id, reader_session, audience_at_posting, delivered_at, acknowledged_at
      ) VALUES (
        ${input.messageId}::uuid, ${input.userId}::uuid, ${input.readerSession},
        ${input.audienceAtPosting}, ${deliveredAt}::timestamptz, ${acknowledgedAt}::timestamptz
      )
      ON CONFLICT (message_id, reader_user_id, reader_session) DO UPDATE SET
        delivered_at = COALESCE(board_receipt.delivered_at, EXCLUDED.delivered_at),
        acknowledged_at = COALESCE(board_receipt.acknowledged_at, EXCLUDED.acknowledged_at)
      RETURNING *
    `
    if (!rows[0])
      throw new RecordBoardError(`board receipt for ${input.messageId} was not stored`, 409)
    return hostedBoardReceiptView(rows[0] as Record<string, unknown>)
  })
}

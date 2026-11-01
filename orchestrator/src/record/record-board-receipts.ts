// concern: record-board-receipts
/** Owns hosted board receipt writes. Must not know HTTP or local stores. */

import type { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  BOARD_MESSAGE_REVISION_LOCK_KEY,
  type HostedBoardReceipt,
  type HostedBoardReceiptInput,
  type HostedBoardStatus,
  RecordBoardError,
} from './record-board-contract.ts'
import { hostedBoardMessageView, loadHostedBoardMessage } from './record-board-messages.ts'
import { type BoardTenant, withBoardTenant } from './record-board-tx.ts'

const iso = (value: unknown) => (value == null ? null : new Date(String(value)).toISOString())

/** The migration that adds the definer function a reader's acknowledgement needs. */
const BOARD_RECEIPT_REVISION_MIGRATION = '20261026044618_dev_1766_board_ack_revision'

const BOARD_RECEIPT_REVISION_MIGRATION_REMEDY = `board acknowledgement requires record migration ${BOARD_RECEIPT_REVISION_MIGRATION}; apply it with \`${PLATFORM_SLUG} record migrate\`, then retry`

export function hostedBoardReceiptView(row: Record<string, unknown>): HostedBoardReceipt {
  return {
    messageId: String(row.message_id),
    readerUserId: String(row.reader_user_id),
    readerSession: String(row.reader_session),
    readerRunRecordId: row.reader_run_record_id == null ? null : String(row.reader_run_record_id),
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
      SELECT message_id, reader_user_id, reader_session, reader_run_record_id, audience_at_posting,
        delivered_at, acknowledged_at
      FROM board_receipt
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
    const prior = (await tx`
      SELECT acknowledged_at FROM board_receipt
      WHERE message_id=${input.messageId}::uuid
        AND reader_user_id=${input.userId}::uuid
        AND reader_session=${input.readerSession}
    `) as { acknowledged_at: unknown }[]
    const deliveredAt = input.delivered ? clock : null
    const acknowledgedAt = input.acknowledged ? clock : null
    const rows = await tx`
      INSERT INTO board_receipt (
        id, message_id, reader_user_id, reader_session, reader_run_record_id, audience_at_posting, delivered_at, acknowledged_at
      ) VALUES (
        ${newRecordId()}::uuid, ${input.messageId}::uuid, ${input.userId}::uuid, ${input.readerSession}, ${input.readerRunRecordId ?? null}::uuid,
        ${input.audienceAtPosting}, ${deliveredAt}::timestamptz, ${acknowledgedAt}::timestamptz
      )
      ON CONFLICT (message_id, reader_user_id, reader_session) DO UPDATE SET
        delivered_at = COALESCE(board_receipt.delivered_at, EXCLUDED.delivered_at),
        reader_run_record_id = COALESCE(board_receipt.reader_run_record_id, EXCLUDED.reader_run_record_id),
        acknowledged_at = COALESCE(board_receipt.acknowledged_at, EXCLUDED.acknowledged_at)
      RETURNING message_id, reader_user_id, reader_session, reader_run_record_id, audience_at_posting,
        delivered_at, acknowledged_at
    `
    if (!rows[0])
      throw new RecordBoardError(`board receipt for ${input.messageId} was not stored`, 409)
    // A first acknowledgement is the only receipt write another reader must learn about, so
    // it advances the message revision the change feed pages on. Delivery stays per session.
    if (acknowledgedAt !== null && (prior[0]?.acknowledged_at ?? null) === null) {
      await advanceReceiptRevision(tx, input.messageId)
    }
    return hostedBoardReceiptView(rows[0] as Record<string, unknown>)
  })
}

async function advanceReceiptRevision(tx: SQL, messageId: string): Promise<void> {
  const available = (await tx`
    SELECT to_regprocedure('public.board_message_advance_receipt_revision(uuid)') IS NOT NULL AS available
  `) as { available: boolean }[]
  if (!available[0]?.available)
    throw new RecordBoardError(BOARD_RECEIPT_REVISION_MIGRATION_REMEDY, 409)
  // Order the bump with the writers' lock, so it cannot commit below an advanced feed cursor.
  await tx`SELECT pg_advisory_xact_lock(${BOARD_MESSAGE_REVISION_LOCK_KEY})`
  const rows = (await tx`
    SELECT public.board_message_advance_receipt_revision(${messageId}::uuid) AS advanced
  `) as { advanced: boolean }[]
  if (!rows[0]?.advanced)
    throw new RecordBoardError(
      `board acknowledgement for message ${messageId} did not advance its revision; the receipt was not stored, retry once the record answers`,
      409,
    )
}

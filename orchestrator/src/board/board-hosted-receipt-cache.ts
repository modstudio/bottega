// concern: hosted-board-receipt-cache
/** Owns the local hosted receipt mirror write. */

import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { writableDb } from '../database/db.ts'
import type { HostedBoardReceipt } from '../record/record-board-contract.ts'

export function cacheHostedBoardReceipt(
  receipt: HostedBoardReceipt,
  database: Database = writableDb(),
): void {
  database
    .query(
      `INSERT INTO hosted_board_receipt_cache
       (record_id,message_id,reader_session,reader_run_record_id,audience_at_posting,delivered_at,acknowledged_at,successor,pending_sync)
       SELECT ?,?,?,?,?,?,?,?,0 WHERE EXISTS (
         SELECT 1 FROM hosted_board_message_cache WHERE id=?
       ) ON CONFLICT(message_id,reader_session) DO UPDATE SET
       reader_run_record_id=COALESCE(hosted_board_receipt_cache.reader_run_record_id,excluded.reader_run_record_id),
       audience_at_posting=excluded.audience_at_posting,
       delivered_at=COALESCE(hosted_board_receipt_cache.delivered_at,excluded.delivered_at),
       acknowledged_at=COALESCE(hosted_board_receipt_cache.acknowledged_at,excluded.acknowledged_at),
       successor=excluded.successor,
       pending_sync=CASE WHEN hosted_board_receipt_cache.pending_sync=1 AND (
         (hosted_board_receipt_cache.delivered_at IS NOT NULL AND excluded.delivered_at IS NULL) OR
         (hosted_board_receipt_cache.acknowledged_at IS NOT NULL AND excluded.acknowledged_at IS NULL)
       ) THEN 1 ELSE 0 END,
       sync_error=NULL`,
    )
    .run(
      newRecordId(),
      receipt.messageId,
      receipt.readerSession,
      receipt.readerRunRecordId ?? null,
      receipt.audienceAtPosting ? 1 : 0,
      receipt.deliveredAt,
      receipt.acknowledgedAt,
      receipt.successor ? 1 : 0,
      receipt.messageId,
    )
}

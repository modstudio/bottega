ALTER TABLE board_receipt ADD COLUMN reader_run_record_id TEXT REFERENCES run(record_id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE board_hosted_adoption_receipt ADD COLUMN reader_run_record_id TEXT REFERENCES run(record_id) ON UPDATE CASCADE ON DELETE SET NULL;
-- Hosted receipt-cache rows may name runs that do not exist on this machine.
ALTER TABLE hosted_board_receipt_cache ADD COLUMN reader_run_record_id TEXT;
CREATE INDEX board_receipt_reader_run ON board_receipt(reader_run_record_id);
CREATE INDEX board_hosted_adoption_receipt_reader_run ON board_hosted_adoption_receipt(reader_run_record_id);
--> statement-breakpoint
-- BACKFILL
UPDATE board_receipt AS receipt
SET reader_run_record_id = substr(receipt.reader_session, 5)
WHERE receipt.reader_run_record_id IS NULL
  AND receipt.reader_session GLOB 'run:????????-????-????-????-????????????'
  AND EXISTS (SELECT 1 FROM run WHERE run.record_id = substr(receipt.reader_session, 5));

UPDATE board_hosted_adoption_receipt AS receipt
SET reader_run_record_id = substr(receipt.reader_session, 5)
WHERE receipt.reader_run_record_id IS NULL
  AND receipt.reader_session GLOB 'run:????????-????-????-????-????????????'
  AND EXISTS (SELECT 1 FROM run WHERE run.record_id = substr(receipt.reader_session, 5));

UPDATE hosted_board_receipt_cache AS receipt
SET reader_run_record_id = substr(receipt.reader_session, 5)
WHERE receipt.reader_run_record_id IS NULL
  AND receipt.reader_session GLOB 'run:????????-????-????-????-????????????';
-- /BACKFILL

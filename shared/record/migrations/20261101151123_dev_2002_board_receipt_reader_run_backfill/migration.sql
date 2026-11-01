ALTER TABLE board_receipt NO FORCE ROW LEVEL SECURITY;
ALTER TABLE run NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  remaining_null bigint;
BEGIN
  UPDATE board_receipt AS receipt
  SET reader_run_record_id = substring(receipt.reader_session FROM 5)::uuid
  WHERE receipt.reader_run_record_id IS NULL
    AND receipt.reader_session ~ '^run:[0-9a-fA-F-]{36}$'
    AND EXISTS (
      SELECT 1 FROM run WHERE run.id = substring(receipt.reader_session FROM 5)::uuid
    );

  SELECT count(*) INTO remaining_null
  FROM board_receipt
  WHERE reader_run_record_id IS NULL;

  RAISE NOTICE 'DEV-2002 board receipt reader run ids: NULL=%', remaining_null;

END $$;

ALTER TABLE run FORCE ROW LEVEL SECURITY;
ALTER TABLE board_receipt FORCE ROW LEVEL SECURITY;

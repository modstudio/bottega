ALTER TABLE board_receipt ADD COLUMN successor INTEGER NOT NULL DEFAULT 0
  CHECK (successor IN (0,1));
ALTER TABLE hosted_board_receipt_cache ADD COLUMN successor INTEGER NOT NULL DEFAULT 0
  CHECK (successor IN (0,1));

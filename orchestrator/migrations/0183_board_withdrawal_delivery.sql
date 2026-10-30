CREATE TABLE board_withdrawal_delivery (
  record_id TEXT NOT NULL PRIMARY KEY,
  reader_session TEXT NOT NULL,
  message_record_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('local','hosted')),
  delivered_at TEXT NOT NULL,
  UNIQUE (reader_session,message_record_id)
);

ALTER TABLE board_message ADD COLUMN withdrawn_reason TEXT;

CREATE TABLE board_withdrawal_delivery (
  reader_session TEXT NOT NULL,
  message_record_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('local','hosted')),
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (reader_session,message_record_id)
);

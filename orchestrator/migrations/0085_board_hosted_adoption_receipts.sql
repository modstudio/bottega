CREATE TABLE board_hosted_adoption_receipt (
  local_message_id INTEGER NOT NULL,
  reader_session TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('uploaded','skipped')),
  refusal TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (local_message_id,reader_session),
  CHECK ((state='skipped' AND refusal IS NOT NULL) OR (state='uploaded' AND refusal IS NULL))
);

CREATE TABLE hosted_outbox_trace (
  id TEXT PRIMARY KEY NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert','delete')),
  destination_space_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied','duplicate','replaced','rejected','dropped')),
  reason TEXT,
  generation INTEGER NOT NULL,
  process_kind TEXT NOT NULL CHECK (process_kind IN ('collector','command')),
  created_at TEXT NOT NULL
);

CREATE INDEX hosted_outbox_trace_created_at_idx
ON hosted_outbox_trace(created_at);

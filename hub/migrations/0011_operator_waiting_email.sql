CREATE TABLE operator_waiting_email (
  kind TEXT NOT NULL CHECK (kind IN ('question','workflow')),
  item_id INTEGER NOT NULL,
  episode TEXT NOT NULL,
  pushed_at TEXT NOT NULL,
  PRIMARY KEY (kind,item_id,episode)
);

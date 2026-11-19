CREATE TABLE record_local_by_design (
  record_id TEXT PRIMARY KEY,
  mark TEXT NOT NULL CHECK (mark = 'local')
);

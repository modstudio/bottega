CREATE TABLE board_hosted_adoption_ledger (
  local_kind TEXT NOT NULL CHECK (local_kind IN ('notice','question','reply','claim')),
  local_id INTEGER NOT NULL,
  hosted_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','uploaded','refused')),
  refusal TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (local_kind,local_id),
  CHECK ((state='refused' AND refusal IS NOT NULL) OR (state<>'refused' AND refusal IS NULL))
);

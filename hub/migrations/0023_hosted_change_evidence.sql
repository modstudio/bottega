CREATE TABLE hosted_change_evidence (
  record_id TEXT PRIMARY KEY NOT NULL,
  observed_at TEXT NOT NULL,
  family TEXT NOT NULL CHECK (family IN ('task','note')),
  space_id TEXT NOT NULL,
  hosted_table TEXT NOT NULL,
  row_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('changed-upsert','applied-delete','skipped-delete')),
  differing_columns TEXT NOT NULL CHECK (json_valid(differing_columns))
);
--> statement-breakpoint
CREATE INDEX hosted_change_evidence_newest
ON hosted_change_evidence(observed_at DESC, record_id DESC);
--> statement-breakpoint
CREATE INDEX hosted_change_evidence_filters
ON hosted_change_evidence(family, space_id, kind, observed_at DESC, record_id DESC);

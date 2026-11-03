CREATE TABLE typed_question_answer (
  record_id TEXT NOT NULL PRIMARY KEY,
  question_id TEXT NOT NULL,
  question_version INTEGER NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  state_sha TEXT NOT NULL,
  answer_json TEXT,
  model TEXT,
  input_tokens INTEGER,
  latency_ms INTEGER NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX typed_question_answer_question_subject_idx
ON typed_question_answer(question_id, subject_ref);

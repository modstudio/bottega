PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
-- newRecordId() is the runtime minter; these are migration-only random UUID-v4 values.
CREATE TEMP TABLE blocker_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='blocker'),0) seq;
CREATE TEMP TABLE calibration_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='calibration'),0) seq;
CREATE TEMP TABLE canon_eval_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='canon_eval'),0) seq;
CREATE TEMP TABLE duel_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='duel'),0) seq;
CREATE TEMP TABLE run_checkpoint_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='run_checkpoint'),0) seq;
CREATE TEMP TABLE score_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='score'),0) seq;
CREATE TEMP TABLE gate_execution_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='gate_execution'),0) seq;
CREATE TEMP TABLE check_execution_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='check_execution'),0) seq;
CREATE TEMP TABLE resource_claim_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='resource_claim'),0) seq;
CREATE TEMP TABLE question_delivery_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='question_delivery'),0) seq;
--> statement-breakpoint
CREATE TEMP TABLE blocker_before_record_identity AS SELECT * FROM blocker;
CREATE TEMP TABLE calibration_before_record_identity AS SELECT * FROM calibration;
CREATE TEMP TABLE canon_eval_before_record_identity AS SELECT * FROM canon_eval;
CREATE TEMP TABLE compared_pair_before_record_identity AS SELECT * FROM compared_pair;
CREATE TEMP TABLE duel_before_record_identity AS SELECT * FROM duel;
CREATE TEMP TABLE run_carried_ruling_before_record_identity AS SELECT * FROM run_carried_ruling;
CREATE TEMP TABLE run_checkpoint_before_record_identity AS SELECT * FROM run_checkpoint;
CREATE TEMP TABLE run_mutation_audit_before_record_identity AS SELECT * FROM run_mutation_audit;
CREATE TEMP TABLE score_before_record_identity AS SELECT * FROM score;
CREATE TEMP TABLE check_execution_before_record_identity AS SELECT * FROM check_execution;
CREATE TEMP TABLE gate_execution_before_record_identity AS SELECT * FROM gate_execution;
CREATE TEMP TABLE resource_claim_before_record_identity AS SELECT * FROM resource_claim;
CREATE TEMP TABLE question_delivery_before_record_identity AS SELECT * FROM question_delivery;
CREATE TEMP TABLE question_mutation_audit_before_record_identity AS SELECT * FROM question_mutation_audit;
CREATE TEMP TABLE review_finding_amendment_before_record_identity AS SELECT * FROM review_finding_amendment;
--> statement-breakpoint
DELETE FROM check_execution;
DELETE FROM gate_execution;
DELETE FROM blocker;
DELETE FROM calibration;
DELETE FROM canon_eval;
DELETE FROM compared_pair;
DELETE FROM duel;
DELETE FROM run_carried_ruling;
DELETE FROM run_checkpoint;
DELETE FROM run_mutation_audit;
DELETE FROM score;
DELETE FROM resource_claim;
DELETE FROM question_delivery;
DELETE FROM question_mutation_audit;
DELETE FROM review_finding_amendment;
--> statement-breakpoint
CREATE TABLE blocker_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  what TEXT NOT NULL,
  why TEXT,
  impact TEXT,
  source TEXT NOT NULL CHECK (source IN ('declared','detected')),
  kind TEXT,
  record_id TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO blocker_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM blocker_before_record_identity ORDER BY id;
DROP TABLE blocker;
ALTER TABLE blocker_record_identity RENAME TO blocker;
--> statement-breakpoint
CREATE TABLE calibration_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  delivery TEXT NOT NULL CHECK (delivery IN ('none','partial','full')),
  quality TEXT CHECK (quality IN ('wrong','mixed','right')),
  fidelity TEXT CHECK (fidelity IS NULL OR fidelity IN ('drifted','partial','faithful')),
  at TEXT NOT NULL,
  session_id TEXT,
  record_id TEXT NOT NULL,
  CHECK ((delivery = 'none') = (quality IS NULL))
);
--> statement-breakpoint
INSERT INTO calibration_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM calibration_before_record_identity ORDER BY id;
DROP TABLE calibration;
ALTER TABLE calibration_record_identity RENAME TO calibration;
--> statement-breakpoint
CREATE TABLE canon_eval_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  run_id INTEGER NOT NULL REFERENCES run(id),
  canon_sha TEXT NOT NULL,
  agent TEXT NOT NULL,
  model TEXT,
  pass INTEGER NOT NULL,
  why TEXT NOT NULL,
  at TEXT NOT NULL,
  record_id TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO canon_eval_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM canon_eval_before_record_identity ORDER BY id;
DROP TABLE canon_eval;
ALTER TABLE canon_eval_record_identity RENAME TO canon_eval;
--> statement-breakpoint
CREATE TABLE compared_pair_record_identity (
  run_a_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  run_b_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  compared_at TEXT NOT NULL,
  record_id TEXT NOT NULL,
  PRIMARY KEY (run_a_id, run_b_id),
  CHECK (run_a_id < run_b_id)
);
--> statement-breakpoint
INSERT INTO compared_pair_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM compared_pair_before_record_identity ORDER BY run_a_id, run_b_id;
DROP TABLE compared_pair;
ALTER TABLE compared_pair_record_identity RENAME TO compared_pair;
--> statement-breakpoint
CREATE TABLE duel_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  winner_run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  loser_run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  session_id TEXT,
  at TEXT NOT NULL,
  record_id TEXT NOT NULL,
  CHECK (winner_run_id <> loser_run_id),
  UNIQUE (winner_run_id, loser_run_id)
);
--> statement-breakpoint
INSERT INTO duel_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM duel_before_record_identity ORDER BY id;
DROP TABLE duel;
ALTER TABLE duel_record_identity RENAME TO duel;
--> statement-breakpoint
CREATE TABLE run_carried_ruling_record_identity (
  run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES question(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL,
  PRIMARY KEY (run_id, question_id)
);
--> statement-breakpoint
INSERT INTO run_carried_ruling_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM run_carried_ruling_before_record_identity ORDER BY run_id, question_id;
DROP TABLE run_carried_ruling;
ALTER TABLE run_carried_ruling_record_identity RENAME TO run_carried_ruling;
--> statement-breakpoint
CREATE TABLE run_checkpoint_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  checkpoint_no INTEGER NOT NULL,
  commit_sha TEXT NOT NULL,
  task_pointer TEXT,
  final INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  record_id TEXT NOT NULL,
  UNIQUE(run_id, checkpoint_no)
);
--> statement-breakpoint
INSERT INTO run_checkpoint_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM run_checkpoint_before_record_identity ORDER BY id;
DROP TABLE run_checkpoint;
ALTER TABLE run_checkpoint_record_identity RENAME TO run_checkpoint;
--> statement-breakpoint
CREATE TABLE run_mutation_audit_record_identity (
  run_id INTEGER NOT NULL REFERENCES run(id),
  root_id INTEGER NOT NULL REFERENCES run(id),
  action TEXT NOT NULL CHECK (action IN ('adopt','answer','overturn','file','tell','relay','stop','abandon','discard','sweep','reap','void','unvoid','score','rescore','retry','continue','reclassify','canon-eval')),
  actor_session TEXT CHECK (actor_session IS NULL OR length(actor_session) > 0),
  at TEXT NOT NULL,
  reason TEXT,
  turn_id INTEGER REFERENCES run(id),
  record_id TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO run_mutation_audit_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM run_mutation_audit_before_record_identity ORDER BY at, run_id, action;
DROP TABLE run_mutation_audit;
ALTER TABLE run_mutation_audit_record_identity RENAME TO run_mutation_audit;
--> statement-breakpoint
CREATE TABLE score_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  delivery TEXT NOT NULL CHECK (delivery IN ('none','partial','full')),
  quality TEXT CHECK (quality IN ('wrong','mixed','right')),
  fidelity TEXT CHECK (fidelity IS NULL OR fidelity IN ('drifted','partial','faithful')),
  note TEXT,
  scored_at TEXT NOT NULL,
  scored_by TEXT NOT NULL DEFAULT 'claude',
  record_id TEXT NOT NULL,
  CHECK ((delivery = 'none') = (quality IS NULL))
);
--> statement-breakpoint
INSERT INTO score_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM score_before_record_identity ORDER BY id;
DROP TABLE score;
ALTER TABLE score_record_identity RENAME TO score;
--> statement-breakpoint
CREATE TABLE gate_execution_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER REFERENCES run(id) ON DELETE CASCADE,
  requested_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  exit_code INTEGER,
  timed_out INTEGER CHECK (timed_out IS NULL OR timed_out IN (0,1)),
  elapsed_ms INTEGER,
  output_tail TEXT,
  output_artifact TEXT,
  cancelled_reason TEXT,
  tooling_paths TEXT NOT NULL DEFAULT '[]',
  resolved_command TEXT,
  head_commit TEXT,
  session_id TEXT,
  cwd TEXT,
  record_id TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO gate_execution_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM gate_execution_before_record_identity ORDER BY id;
DROP TABLE gate_execution;
ALTER TABLE gate_execution_record_identity RENAME TO gate_execution;
--> statement-breakpoint
CREATE TABLE check_execution_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gate_execution_id INTEGER NOT NULL REFERENCES gate_execution(id) ON DELETE CASCADE,
  check_name TEXT NOT NULL,
  category TEXT,
  wall_ms REAL NOT NULL CHECK (wall_ms >= 0),
  cpu_ms REAL CHECK (cpu_ms IS NULL OR cpu_ms >= 0),
  exit_code INTEGER NOT NULL,
  remaining_count INTEGER CHECK (remaining_count IS NULL OR remaining_count >= 0),
  record_id TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO check_execution_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM check_execution_before_record_identity ORDER BY id;
DROP TABLE check_execution;
ALTER TABLE check_execution_record_identity RENAME TO check_execution;
--> statement-breakpoint
CREATE TABLE resource_claim_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_run_id INTEGER NOT NULL REFERENCES run(id),
  run_id INTEGER NOT NULL REFERENCES run(id),
  project_id INTEGER REFERENCES project(id),
  kind TEXT NOT NULL CHECK (kind IN ('worktree','branch','retained_ref','sandbox_dir','trust_entry','port','database','index','string')),
  allocation_key TEXT NOT NULL,
  identity TEXT,
  label TEXT,
  state TEXT NOT NULL CHECK (state IN ('claimed','released','retained','forgotten','absent')),
  claimed_at TEXT NOT NULL,
  settled_at TEXT,
  settled_detail TEXT,
  record_id TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO resource_claim_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM resource_claim_before_record_identity ORDER BY id;
DROP TABLE resource_claim;
ALTER TABLE resource_claim_record_identity RENAME TO resource_claim;
--> statement-breakpoint
CREATE TABLE question_delivery_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES question(id) ON DELETE CASCADE,
  run_id INTEGER REFERENCES run(id) ON DELETE SET NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'resume', 'retry', 'record-only')),
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'failed', 'retired')),
  at TEXT NOT NULL,
  error TEXT,
  record_id TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO question_delivery_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM question_delivery_before_record_identity ORDER BY id;
DROP TABLE question_delivery;
ALTER TABLE question_delivery_record_identity RENAME TO question_delivery;
--> statement-breakpoint
CREATE TABLE question_mutation_audit_record_identity (
  question_id INTEGER NOT NULL REFERENCES question(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('rule','overturn','file','close')),
  actor_session TEXT,
  at TEXT NOT NULL,
  reason TEXT,
  record_id TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO question_mutation_audit_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM question_mutation_audit_before_record_identity ORDER BY at, question_id, action;
DROP TABLE question_mutation_audit;
ALTER TABLE question_mutation_audit_record_identity RENAME TO question_mutation_audit;
--> statement-breakpoint
CREATE TABLE review_finding_amendment_record_identity (
  review_id INTEGER NOT NULL REFERENCES review(id),
  finding_ordinal INTEGER NOT NULL,
  old_disposition TEXT CHECK (old_disposition IN ('accepted','modified','rejected','skipped')),
  new_disposition TEXT NOT NULL CHECK (new_disposition IN ('accepted','modified','rejected','skipped')),
  old_rejection_category TEXT,
  new_rejection_category TEXT,
  old_triaged_severity TEXT CHECK (old_triaged_severity IN ('critical','high','medium','low')),
  new_triaged_severity TEXT CHECK (new_triaged_severity IN ('critical','high','medium','low')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  actor_session TEXT CHECK (actor_session IS NULL OR length(actor_session) > 0),
  at TEXT NOT NULL,
  record_id TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO review_finding_amendment_record_identity
SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
FROM review_finding_amendment_before_record_identity ORDER BY at, review_id, finding_ordinal;
DROP TABLE review_finding_amendment;
ALTER TABLE review_finding_amendment_record_identity RENAME TO review_finding_amendment;
--> statement-breakpoint
CREATE INDEX blocker_kind ON blocker(kind, at);
CREATE INDEX blocker_run ON blocker(run_id);
CREATE UNIQUE INDEX blocker_record_id_unique ON blocker(record_id);
CREATE UNIQUE INDEX calibration_record_id_unique ON calibration(record_id);
CREATE UNIQUE INDEX canon_eval_record_id_unique ON canon_eval(record_id);
CREATE UNIQUE INDEX compared_pair_record_id_unique ON compared_pair(record_id);
CREATE INDEX duel_job ON duel(job);
CREATE UNIQUE INDEX duel_record_id_unique ON duel(record_id);
CREATE UNIQUE INDEX run_carried_ruling_record_id_unique ON run_carried_ruling(record_id);
CREATE UNIQUE INDEX run_checkpoint_record_id_unique ON run_checkpoint(record_id);
CREATE INDEX run_mutation_audit_root ON run_mutation_audit(root_id);
CREATE INDEX run_mutation_audit_turn ON run_mutation_audit(turn_id);
CREATE UNIQUE INDEX run_mutation_audit_record_id_unique ON run_mutation_audit(record_id);
CREATE UNIQUE INDEX score_one_per_run ON score(run_id);
CREATE INDEX score_run ON score(run_id);
CREATE UNIQUE INDEX score_record_id_unique ON score(record_id);
CREATE UNIQUE INDEX gate_execution_one_active ON gate_execution(run_id) WHERE finished_at IS NULL;
CREATE INDEX gate_execution_run ON gate_execution(run_id,id);
CREATE UNIQUE INDEX gate_execution_record_id_unique ON gate_execution(record_id);
CREATE INDEX check_execution_category_newest ON check_execution(category, gate_execution_id DESC);
CREATE UNIQUE INDEX check_execution_record_id_unique ON check_execution(record_id);
CREATE UNIQUE INDEX resource_claim_one_live_allocation ON resource_claim(kind, allocation_key) WHERE state='claimed';
CREATE UNIQUE INDEX resource_claim_record_id_unique ON resource_claim(record_id);
CREATE UNIQUE INDEX question_delivery_record_id_unique ON question_delivery(record_id);
CREATE INDEX question_mutation_audit_question ON question_mutation_audit(question_id,at);
CREATE UNIQUE INDEX question_mutation_audit_record_id_unique ON question_mutation_audit(record_id);
CREATE INDEX review_finding_amendment_review ON review_finding_amendment(review_id, finding_ordinal, at);
CREATE UNIQUE INDEX review_finding_amendment_record_id_unique ON review_finding_amendment(record_id);
--> statement-breakpoint
DELETE FROM sqlite_sequence WHERE name IN (
  'blocker','calibration','canon_eval','duel','run_checkpoint','score',
  'gate_execution','check_execution','resource_claim','question_delivery'
);
INSERT INTO sqlite_sequence(name,seq)
SELECT 'blocker',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM blocker),0))
FROM blocker_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'calibration',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM calibration),0))
FROM calibration_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'canon_eval',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM canon_eval),0))
FROM canon_eval_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'duel',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM duel),0))
FROM duel_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'run_checkpoint',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM run_checkpoint),0))
FROM run_checkpoint_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'score',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM score),0))
FROM score_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'gate_execution',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM gate_execution),0))
FROM gate_execution_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'check_execution',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM check_execution),0))
FROM check_execution_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'resource_claim',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM resource_claim),0))
FROM resource_claim_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'question_delivery',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM question_delivery),0))
FROM question_delivery_sequence_before_record_identity saved;
--> statement-breakpoint
DROP TABLE blocker_before_record_identity;
DROP TABLE calibration_before_record_identity;
DROP TABLE canon_eval_before_record_identity;
DROP TABLE compared_pair_before_record_identity;
DROP TABLE duel_before_record_identity;
DROP TABLE run_carried_ruling_before_record_identity;
DROP TABLE run_checkpoint_before_record_identity;
DROP TABLE run_mutation_audit_before_record_identity;
DROP TABLE score_before_record_identity;
DROP TABLE check_execution_before_record_identity;
DROP TABLE gate_execution_before_record_identity;
DROP TABLE resource_claim_before_record_identity;
DROP TABLE question_delivery_before_record_identity;
DROP TABLE question_mutation_audit_before_record_identity;
DROP TABLE review_finding_amendment_before_record_identity;
DROP TABLE blocker_sequence_before_record_identity;
DROP TABLE calibration_sequence_before_record_identity;
DROP TABLE canon_eval_sequence_before_record_identity;
DROP TABLE duel_sequence_before_record_identity;
DROP TABLE run_checkpoint_sequence_before_record_identity;
DROP TABLE score_sequence_before_record_identity;
DROP TABLE gate_execution_sequence_before_record_identity;
DROP TABLE check_execution_sequence_before_record_identity;
DROP TABLE resource_claim_sequence_before_record_identity;
DROP TABLE question_delivery_sequence_before_record_identity;

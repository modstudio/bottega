PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
-- newRecordId() is the runtime minter; these are migration-only random UUID-v4 values.
UPDATE review
SET record_id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
WHERE record_id IS NULL;
--> statement-breakpoint
UPDATE review_lens
SET record_id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
WHERE record_id IS NULL;
--> statement-breakpoint
UPDATE review_finding
SET record_id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
WHERE record_id IS NULL;
--> statement-breakpoint
UPDATE landing
SET record_id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
WHERE record_id IS NULL;
--> statement-breakpoint
UPDATE landing_override
SET record_id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
WHERE record_id IS NULL;
--> statement-breakpoint
UPDATE landing_review_carry
SET record_id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
WHERE record_id IS NULL;
--> statement-breakpoint
UPDATE contention
SET record_id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
WHERE record_id IS NULL;
--> statement-breakpoint
UPDATE test_flake
SET record_id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
WHERE record_id IS NULL;
--> statement-breakpoint
UPDATE release_ledger
SET record_id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
WHERE record_id IS NULL;
--> statement-breakpoint
UPDATE doc_revision
SET record_id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
WHERE record_id IS NULL;
--> statement-breakpoint
CREATE TEMP TABLE review_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='review'),0) seq;
CREATE TEMP TABLE review_lens_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='review_lens'),0) seq;
CREATE TEMP TABLE review_finding_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='review_finding'),0) seq;
CREATE TEMP TABLE landing_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='landing'),0) seq;
CREATE TEMP TABLE landing_override_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='landing_override'),0) seq;
CREATE TEMP TABLE landing_review_carry_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='landing_review_carry'),0) seq;
CREATE TEMP TABLE contention_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='contention'),0) seq;
CREATE TEMP TABLE test_flake_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='test_flake'),0) seq;
CREATE TEMP TABLE release_ledger_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='release_ledger'),0) seq;
--> statement-breakpoint
CREATE TEMP TABLE review_before_record_identity AS SELECT * FROM review;
CREATE TEMP TABLE review_lens_before_record_identity AS SELECT * FROM review_lens;
CREATE TEMP TABLE review_finding_before_record_identity AS SELECT * FROM review_finding;
CREATE TEMP TABLE landing_before_record_identity AS SELECT * FROM landing;
CREATE TEMP TABLE landing_override_before_record_identity AS SELECT * FROM landing_override;
CREATE TEMP TABLE landing_review_carry_before_record_identity AS SELECT * FROM landing_review_carry;
CREATE TEMP TABLE contention_before_record_identity AS SELECT * FROM contention;
CREATE TEMP TABLE test_flake_before_record_identity AS SELECT * FROM test_flake;
CREATE TEMP TABLE release_ledger_before_record_identity AS SELECT * FROM release_ledger;
CREATE TEMP TABLE doc_revision_before_record_identity AS SELECT * FROM doc_revision;
CREATE TEMP TABLE review_finding_amendment_before_record_identity AS SELECT * FROM review_finding_amendment;
CREATE TEMP TABLE landing_triage_snapshot_before_record_identity AS SELECT * FROM landing_triage_snapshot;
--> statement-breakpoint
DELETE FROM review_finding_amendment;
DELETE FROM landing_triage_snapshot;
DELETE FROM review_finding;
DELETE FROM review_lens;
DELETE FROM landing_review_carry;
DELETE FROM contention;
DELETE FROM test_flake;
DELETE FROM release_ledger;
DELETE FROM landing;
DELETE FROM landing_override;
DELETE FROM review;
DELETE FROM doc_revision;
--> statement-breakpoint
CREATE TABLE review_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at TEXT NOT NULL,
  completed_at TEXT,
  tier INTEGER,
  tier_risk INTEGER,
  tier_size INTEGER,
  tier_reasons TEXT,
  tier_reason TEXT,
  project_id INTEGER REFERENCES project(id) ON DELETE RESTRICT,
  patch_id TEXT,
  path_set TEXT,
  commit_message TEXT,
  outdated_at TEXT,
  outdated_reason TEXT,
  record_id TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO review_record_identity SELECT * FROM review_before_record_identity ORDER BY id;
DROP TABLE review;
ALTER TABLE review_record_identity RENAME TO review;
--> statement-breakpoint
CREATE TABLE landing_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  project_id INTEGER REFERENCES project(id) ON DELETE RESTRICT,
  branch TEXT NOT NULL,
  tip TEXT,
  trunk_before TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'queued','running','landed','refused','install_failed','rebase_required'
  )),
  error TEXT,
  session_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  path_set TEXT CHECK (path_set IS NULL OR json_valid(path_set)),
  requested_at TEXT,
  steps TEXT CHECK (steps IS NULL OR json_valid(steps)),
  causing_landing_id INTEGER,
  claim_pid INTEGER,
  claim_session TEXT,
  heartbeat_delivered_at TEXT,
  record_id TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO landing_record_identity SELECT * FROM landing_before_record_identity ORDER BY id;
DROP TABLE landing;
ALTER TABLE landing_record_identity RENAME TO landing;
--> statement-breakpoint
CREATE TABLE landing_override_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  branch TEXT NOT NULL,
  tip TEXT NOT NULL,
  tree TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  session_id TEXT,
  at TEXT NOT NULL,
  project_id INTEGER REFERENCES project(id) ON DELETE RESTRICT,
  record_id TEXT NOT NULL,
  patch_id TEXT,
  path_set TEXT CHECK (path_set IS NULL OR json_valid(path_set))
);
--> statement-breakpoint
INSERT INTO landing_override_record_identity SELECT * FROM landing_override_before_record_identity ORDER BY id;
DROP TABLE landing_override;
ALTER TABLE landing_override_record_identity RENAME TO landing_override;
--> statement-breakpoint
CREATE TABLE contention_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  session_id TEXT,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN (
    'trunk','main_checkout','store','cpu','vendor','review','register','lock'
  )),
  resource_key TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'wait','refusal','invalidation','retry','timeout'
  )),
  duration_ms INTEGER,
  cause TEXT,
  run_id INTEGER,
  landing_id INTEGER,
  record_id TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO contention_record_identity SELECT * FROM contention_before_record_identity ORDER BY id;
DROP TABLE contention;
ALTER TABLE contention_record_identity RENAME TO contention;
--> statement-breakpoint
CREATE TABLE test_flake_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  test TEXT NOT NULL,
  file TEXT NOT NULL,
  load_at_failure TEXT NOT NULL,
  signal TEXT,
  at TEXT NOT NULL,
  record_id TEXT NOT NULL,
  CHECK (json_valid(load_at_failure))
);
--> statement-breakpoint
INSERT INTO test_flake_record_identity SELECT * FROM test_flake_before_record_identity ORDER BY id;
DROP TABLE test_flake;
ALTER TABLE test_flake_record_identity RENAME TO test_flake;
--> statement-breakpoint
CREATE TABLE release_ledger_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  rung TEXT NOT NULL,
  candidate_commit TEXT NOT NULL,
  live_commit_before TEXT,
  rollback INTEGER NOT NULL CHECK (rollback IN (0,1)),
  rollback_reason TEXT,
  actor TEXT NOT NULL,
  session_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  exit_code INTEGER,
  output_tail TEXT NOT NULL DEFAULT '',
  live_commit_after TEXT,
  live_matches_candidate INTEGER CHECK (live_matches_candidate IN (0,1)),
  warning TEXT,
  record_id TEXT NOT NULL,
  CHECK ((rollback = 1 AND rollback_reason IS NOT NULL) OR (rollback = 0 AND rollback_reason IS NULL)),
  CHECK ((finished_at IS NULL AND exit_code IS NULL) OR (finished_at IS NOT NULL AND exit_code IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO release_ledger_record_identity SELECT * FROM release_ledger_before_record_identity ORDER BY id;
DROP TABLE release_ledger;
ALTER TABLE release_ledger_record_identity RENAME TO release_ledger;
--> statement-breakpoint
CREATE TABLE doc_revision_record_identity (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('project','machine','agent','job','global','stack','resume','canon','settings')),
  subject TEXT,
  slug TEXT NOT NULL CHECK (
    (scope = 'canon' AND length(slug) > 0 AND slug NOT GLOB '/*' AND slug NOT GLOB '*..*') OR
    (scope <> 'canon' AND length(slug) <= 64 AND slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*')
  ),
  project_id INTEGER REFERENCES project(id) ON DELETE RESTRICT,
  op TEXT NOT NULL CHECK (op IN ('create','set','consume','delete','restore','import','backfill')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  delivery TEXT NOT NULL DEFAULT 'inject' CHECK (delivery IN ('inject','demand')),
  author TEXT NOT NULL CHECK (length(trim(author)) > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  session_id TEXT,
  at TEXT NOT NULL,
  record_id TEXT NOT NULL,
  owner TEXT,
  audiences TEXT NOT NULL CHECK (json_valid(audiences) AND json_type(audiences) = 'array' AND json_array_length(audiences) > 0),
  parent_id INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0,1)),
  replacement_slug TEXT,
  status TEXT NOT NULL DEFAULT 'current'
    CHECK (status IN ('draft','current','superseded','archived'))
    CHECK ((status = 'superseded') = (replacement_slug IS NOT NULL)),
  kind TEXT NOT NULL DEFAULT 'working' CHECK (kind IN ('working','article')),
  form TEXT CHECK (form IS NULL OR form IN ('feature','how-to','rule','model','overview')),
  article_subject_id TEXT REFERENCES subject(id) ON DELETE RESTRICT,
  related_subject_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(related_subject_ids) AND json_type(related_subject_ids) = 'array'),
  source_files TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_files) AND json_type(source_files) = 'array'),
  checked_against_commit TEXT,
  CHECK (
    (owner IS NOT NULL AND scope IN ('canon','settings') AND subject IS NULL) OR
    (owner IS NULL AND (
      (scope IN ('machine','global') AND subject IS NULL) OR
      (scope IN ('project','stack','agent','job','resume') AND subject IS NOT NULL) OR
      scope IN ('canon','settings')
    ))
  )
);
--> statement-breakpoint
INSERT INTO doc_revision_record_identity SELECT * FROM doc_revision_before_record_identity ORDER BY id;
DROP TABLE doc_revision;
ALTER TABLE doc_revision_record_identity RENAME TO doc_revision;
--> statement-breakpoint
CREATE TABLE review_lens_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES review(id) ON DELETE CASCADE,
  run_id INTEGER NOT NULL UNIQUE REFERENCES run(id) ON DELETE CASCADE,
  lens TEXT NOT NULL,
  agent TEXT NOT NULL,
  model TEXT,
  tree_inspected TEXT,
  reviewed_tree TEXT,
  standards_read TEXT NOT NULL,
  files_covered TEXT NOT NULL,
  commands_run TEXT NOT NULL,
  could_not_verify TEXT NOT NULL,
  reproduced TEXT CHECK (reproduced IS NULL OR reproduced IN ('none','some','all')),
  coverage TEXT CHECK (coverage IS NULL OR coverage IN ('empty','partial','adequate')),
  limits TEXT CHECK (limits IS NULL OR limits IN ('named','absent')),
  overlap TEXT CHECK (overlap IS NULL OR overlap IN ('unique','shared','none','alone')),
  mcp_tools TEXT NOT NULL DEFAULT '[]',
  docs_read TEXT NOT NULL DEFAULT '[]',
  substitutes TEXT NOT NULL DEFAULT '[]',
  record_id TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO review_lens_record_identity SELECT * FROM review_lens_before_record_identity ORDER BY id;
DROP TABLE review_lens;
ALTER TABLE review_lens_record_identity RENAME TO review_lens;
--> statement-breakpoint
CREATE TABLE review_finding_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES review(id) ON DELETE CASCADE,
  review_lens_id INTEGER NOT NULL REFERENCES review_lens(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  severity TEXT NOT NULL,
  location TEXT NOT NULL,
  evidence TEXT NOT NULL,
  proposed_correction TEXT NOT NULL,
  disposition TEXT CHECK (disposition IS NULL OR disposition IN ('accepted','modified','rejected','skipped')),
  rejection_category TEXT,
  triaged_severity TEXT CHECK (triaged_severity IS NULL OR triaged_severity IN ('critical','high','medium','low')),
  triaged_at TEXT,
  record_id TEXT NOT NULL,
  UNIQUE(review_id, ordinal),
  CHECK (disposition = 'rejected' OR rejection_category IS NULL)
);
--> statement-breakpoint
INSERT INTO review_finding_record_identity SELECT * FROM review_finding_before_record_identity ORDER BY id;
DROP TABLE review_finding;
ALTER TABLE review_finding_record_identity RENAME TO review_finding;
--> statement-breakpoint
CREATE TABLE landing_review_carry_record_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  branch TEXT NOT NULL,
  tip TEXT NOT NULL,
  tree TEXT NOT NULL,
  review_id INTEGER NOT NULL REFERENCES review(id),
  reviewed_commit TEXT NOT NULL,
  reviewed_tree TEXT NOT NULL,
  patch_id TEXT NOT NULL,
  old_base TEXT NOT NULL,
  new_base TEXT NOT NULL,
  session_id TEXT,
  at TEXT NOT NULL,
  project_id INTEGER REFERENCES project(id) ON DELETE RESTRICT,
  record_id TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO landing_review_carry_record_identity SELECT * FROM landing_review_carry_before_record_identity ORDER BY id;
DROP TABLE landing_review_carry;
ALTER TABLE landing_review_carry_record_identity RENAME TO landing_review_carry;
--> statement-breakpoint
CREATE INDEX review_project_id ON review(project_id);
CREATE UNIQUE INDEX review_record_id_unique ON review(record_id);
CREATE INDEX review_calibration ON review_lens(lens, agent, model, review_id);
CREATE UNIQUE INDEX review_lens_record_id_unique ON review_lens(record_id);
CREATE UNIQUE INDEX review_finding_record_id_unique ON review_finding(record_id);
CREATE INDEX landing_project_started ON landing(project, started_at);
CREATE INDEX landing_project_id ON landing(project_id);
CREATE INDEX landing_project_status ON landing(project, status);
CREATE UNIQUE INDEX landing_record_id_unique ON landing(record_id);
CREATE INDEX landing_override_project_id ON landing_override(project_id);
CREATE UNIQUE INDEX landing_override_record_id_unique ON landing_override(record_id);
CREATE INDEX landing_review_carry_project_id ON landing_review_carry(project_id);
CREATE UNIQUE INDEX landing_review_carry_record_id_unique ON landing_review_carry(record_id);
CREATE INDEX contention_kind_at ON contention(resource_kind, at);
CREATE INDEX contention_session_at ON contention(session_id, at);
CREATE INDEX contention_landing ON contention(landing_id);
CREATE UNIQUE INDEX contention_record_id_unique ON contention(record_id);
CREATE INDEX test_flake_test_file_at ON test_flake(test, file, at);
CREATE UNIQUE INDEX test_flake_record_id_unique ON test_flake(record_id);
CREATE INDEX release_ledger_project_rung_started ON release_ledger(project,rung,started_at DESC,id DESC);
CREATE UNIQUE INDEX release_ledger_record_id ON release_ledger(record_id);
CREATE INDEX doc_revision_doc ON doc_revision(doc_id, id);
CREATE INDEX doc_revision_address ON doc_revision(scope, COALESCE(subject, ''), COALESCE(owner, ''), slug, id);
CREATE INDEX doc_revision_project_id ON doc_revision(project_id);
--> statement-breakpoint
INSERT INTO review_finding_amendment SELECT * FROM review_finding_amendment_before_record_identity;
INSERT INTO landing_triage_snapshot SELECT * FROM landing_triage_snapshot_before_record_identity;
--> statement-breakpoint
DELETE FROM sqlite_sequence WHERE name IN (
  'review','review_lens','review_finding','landing','landing_override','landing_review_carry',
  'contention','test_flake','release_ledger'
);
INSERT INTO sqlite_sequence(name,seq)
SELECT 'review',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM review),0))
FROM review_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'review_lens',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM review_lens),0))
FROM review_lens_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'review_finding',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM review_finding),0))
FROM review_finding_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'landing',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM landing),0))
FROM landing_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'landing_override',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM landing_override),0))
FROM landing_override_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'landing_review_carry',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM landing_review_carry),0))
FROM landing_review_carry_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'contention',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM contention),0))
FROM contention_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'test_flake',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM test_flake),0))
FROM test_flake_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'release_ledger',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM release_ledger),0))
FROM release_ledger_sequence_before_record_identity saved;
--> statement-breakpoint
DROP TABLE review_before_record_identity;
DROP TABLE review_lens_before_record_identity;
DROP TABLE review_finding_before_record_identity;
DROP TABLE landing_before_record_identity;
DROP TABLE landing_override_before_record_identity;
DROP TABLE landing_review_carry_before_record_identity;
DROP TABLE contention_before_record_identity;
DROP TABLE test_flake_before_record_identity;
DROP TABLE release_ledger_before_record_identity;
DROP TABLE doc_revision_before_record_identity;
DROP TABLE review_finding_amendment_before_record_identity;
DROP TABLE landing_triage_snapshot_before_record_identity;
DROP TABLE review_sequence_before_record_identity;
DROP TABLE review_lens_sequence_before_record_identity;
DROP TABLE review_finding_sequence_before_record_identity;
DROP TABLE landing_sequence_before_record_identity;
DROP TABLE landing_override_sequence_before_record_identity;
DROP TABLE landing_review_carry_sequence_before_record_identity;
DROP TABLE contention_sequence_before_record_identity;
DROP TABLE test_flake_sequence_before_record_identity;
DROP TABLE release_ledger_sequence_before_record_identity;

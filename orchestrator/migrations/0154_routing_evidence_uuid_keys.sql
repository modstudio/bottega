PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
CREATE TABLE blocker_uuid_key (
  record_id TEXT NOT NULL PRIMARY KEY,
  run_record_id TEXT NOT NULL REFERENCES run(record_id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  what TEXT NOT NULL,
  why TEXT,
  impact TEXT,
  source TEXT NOT NULL CHECK (source IN ('declared','detected')),
  kind TEXT
);
INSERT INTO blocker_uuid_key(record_id,run_record_id,at,what,why,impact,source,kind)
SELECT record_id,run_record_id,at,what,why,impact,source,kind FROM blocker ORDER BY id;
DROP TABLE blocker;
ALTER TABLE blocker_uuid_key RENAME TO blocker;
CREATE INDEX blocker_kind ON blocker(kind,at);
CREATE INDEX blocker_run ON blocker(run_record_id);
--> statement-breakpoint
CREATE TABLE calibration_uuid_key (
  record_id TEXT NOT NULL PRIMARY KEY,
  run_record_id TEXT NOT NULL REFERENCES run(record_id) ON DELETE CASCADE,
  delivery TEXT NOT NULL CHECK (delivery IN ('none','partial','full')),
  quality TEXT CHECK (quality IN ('wrong','mixed','right')),
  fidelity TEXT CHECK (fidelity IS NULL OR fidelity IN ('drifted','partial','faithful')),
  at TEXT NOT NULL,
  session_id TEXT,
  CHECK ((delivery = 'none') = (quality IS NULL))
);
INSERT INTO calibration_uuid_key(record_id,run_record_id,delivery,quality,fidelity,at,session_id)
SELECT record_id,run_record_id,delivery,quality,fidelity,at,session_id FROM calibration ORDER BY id;
DROP TABLE calibration;
ALTER TABLE calibration_uuid_key RENAME TO calibration;
CREATE INDEX calibration_run_record_id_idx ON calibration(run_record_id);
--> statement-breakpoint
CREATE TABLE canon_eval_uuid_key (
  record_id TEXT NOT NULL PRIMARY KEY,
  slug TEXT NOT NULL,
  run_record_id TEXT NOT NULL REFERENCES run(record_id),
  canon_sha TEXT NOT NULL,
  agent TEXT NOT NULL,
  model TEXT,
  pass INTEGER NOT NULL,
  why TEXT NOT NULL,
  at TEXT NOT NULL
);
INSERT INTO canon_eval_uuid_key(record_id,slug,run_record_id,canon_sha,agent,model,pass,why,at)
SELECT record_id,slug,run_record_id,canon_sha,agent,model,pass,why,at FROM canon_eval ORDER BY id;
DROP TABLE canon_eval;
ALTER TABLE canon_eval_uuid_key RENAME TO canon_eval;
CREATE INDEX canon_eval_run_record_id_idx ON canon_eval(run_record_id);
--> statement-breakpoint
CREATE TABLE duel_uuid_key (
  record_id TEXT NOT NULL PRIMARY KEY,
  job TEXT NOT NULL,
  winner_run_record_id TEXT NOT NULL REFERENCES run(record_id) ON DELETE CASCADE,
  loser_run_record_id TEXT NOT NULL REFERENCES run(record_id) ON DELETE CASCADE,
  session_id TEXT,
  at TEXT NOT NULL,
  CHECK (winner_run_record_id <> loser_run_record_id),
  UNIQUE (winner_run_record_id,loser_run_record_id)
);
INSERT INTO duel_uuid_key(record_id,job,winner_run_record_id,loser_run_record_id,session_id,at)
SELECT record_id,job,winner_run_record_id,loser_run_record_id,session_id,at FROM duel ORDER BY id;
DROP TABLE duel;
ALTER TABLE duel_uuid_key RENAME TO duel;
CREATE INDEX duel_job ON duel(job);
CREATE INDEX duel_loser_run_record_id_idx ON duel(loser_run_record_id);
--> statement-breakpoint
CREATE TABLE score_uuid_key (
  record_id TEXT NOT NULL PRIMARY KEY,
  number INTEGER UNIQUE,
  run_record_id TEXT NOT NULL REFERENCES run(record_id) ON DELETE CASCADE,
  delivery TEXT NOT NULL CHECK (delivery IN ('none','partial','full')),
  quality TEXT CHECK (quality IN ('wrong','mixed','right')),
  fidelity TEXT CHECK (fidelity IS NULL OR fidelity IN ('drifted','partial','faithful')),
  note TEXT,
  scored_at TEXT NOT NULL,
  scored_by TEXT NOT NULL DEFAULT 'claude',
  CHECK ((delivery = 'none') = (quality IS NULL))
);
INSERT INTO score_uuid_key(record_id,number,run_record_id,delivery,quality,fidelity,note,scored_at,scored_by)
SELECT record_id,id,run_record_id,delivery,quality,fidelity,note,scored_at,scored_by FROM score ORDER BY id;
INSERT INTO entity_number_counter(record_id,entity,last_number)
SELECT '00000000-0000-4000-8000-000000001684','score',
       MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name='score'),0),COALESCE(MAX(id),0))
FROM score;
DROP TABLE score;
ALTER TABLE score_uuid_key RENAME TO score;
CREATE UNIQUE INDEX score_one_per_run ON score(run_record_id);
CREATE INDEX score_run ON score(run_record_id);
CREATE TRIGGER score_assign_number AFTER INSERT ON score
WHEN NEW.number IS NULL
BEGIN
  SELECT RAISE(ABORT, 'score number counter is missing')
   WHERE NOT EXISTS (SELECT 1 FROM entity_number_counter WHERE entity='score');
  UPDATE entity_number_counter
     SET last_number=MAX(last_number,COALESCE((SELECT MAX(number) FROM score),0))+1
   WHERE entity='score';
  UPDATE score
     SET number=(SELECT last_number FROM entity_number_counter WHERE entity='score')
   WHERE record_id=NEW.record_id;
END;

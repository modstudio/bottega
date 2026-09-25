CREATE TABLE install_binding (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bound INTEGER NOT NULL CHECK (bound IN (0, 1)),
  active_space_id TEXT,
  bound_at TEXT
);
--> statement-breakpoint
CREATE TABLE note_new (
  id INTEGER PRIMARY KEY,
  record_id TEXT,
  project TEXT NOT NULL,
  text TEXT NOT NULL,
  area TEXT,
  anchors TEXT NOT NULL,
  sightings INTEGER NOT NULL DEFAULT 1 CHECK (sightings > 0),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  stale_at TEXT,
  stale_reason TEXT,
  promoted_task TEXT,
  promoted_task_record_id TEXT REFERENCES task(record_id) ON UPDATE CASCADE ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO note_new
SELECT id,record_id,project,text,area,anchors,sightings,created_at,last_seen_at,stale_at,stale_reason,
  promoted_task,promoted_task_record_id FROM note;
--> statement-breakpoint
CREATE TABLE note_acknowledgement_new (
  note_id INTEGER NOT NULL REFERENCES note_new(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  sightings INTEGER NOT NULL CHECK (sightings > 0),
  record_id TEXT,
  PRIMARY KEY (note_id, session_id)
);
--> statement-breakpoint
INSERT INTO note_acknowledgement_new(note_id,session_id,acknowledged_at,sightings,record_id)
SELECT note_id,session_id,acknowledged_at,sightings,record_id FROM note_acknowledgement;
--> statement-breakpoint
DROP TABLE note_acknowledgement;
DROP TABLE note;
--> statement-breakpoint
ALTER TABLE note_new RENAME TO note;
ALTER TABLE note_acknowledgement_new RENAME TO note_acknowledgement;
--> statement-breakpoint
CREATE UNIQUE INDEX note_record_id ON note(record_id) WHERE record_id IS NOT NULL;
CREATE INDEX note_project_seen ON note(project, last_seen_at DESC);
CREATE INDEX note_promoted_task_record_id ON note(promoted_task_record_id);
CREATE UNIQUE INDEX note_acknowledgement_record_id ON note_acknowledgement(record_id) WHERE record_id IS NOT NULL;
CREATE INDEX note_acknowledgement_session ON note_acknowledgement(session_id, acknowledged_at DESC);
--> statement-breakpoint
-- BACKFILL
INSERT OR IGNORE INTO install_binding (id, bound, active_space_id, bound_at)
SELECT 1, 1, NULL, datetime('now')
WHERE EXISTS (SELECT 1 FROM setting WHERE key IN ('collect.hosted-tasks.cursor', 'collect.hosted-notes.cursor'));
-- /BACKFILL

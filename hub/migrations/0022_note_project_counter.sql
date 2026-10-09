PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
CREATE TABLE note_counter (
  project TEXT PRIMARY KEY,
  next INTEGER NOT NULL CHECK (next > 0)
);
--> statement-breakpoint
INSERT INTO note_counter(project,next)
SELECT project,MAX(number)+1 FROM note GROUP BY project;
--> statement-breakpoint
CREATE TABLE note_record (
  record_id TEXT NOT NULL PRIMARY KEY,
  number INTEGER NOT NULL,
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
  promoted_task_record_id TEXT REFERENCES task(record_id) ON UPDATE CASCADE ON DELETE SET NULL,
  UNIQUE(project, number)
);
--> statement-breakpoint
INSERT INTO note_record
  (record_id,number,project,text,area,anchors,sightings,created_at,last_seen_at,stale_at,stale_reason,promoted_task,promoted_task_record_id)
SELECT record_id,number,project,text,area,anchors,sightings,created_at,last_seen_at,stale_at,stale_reason,promoted_task,promoted_task_record_id
FROM note;
--> statement-breakpoint
CREATE TABLE note_acknowledgement_record (
  record_id TEXT NOT NULL PRIMARY KEY,
  note_record_id TEXT NOT NULL REFERENCES note_record(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  sightings INTEGER NOT NULL CHECK (sightings > 0),
  UNIQUE(note_record_id, session_id)
);
--> statement-breakpoint
INSERT INTO note_acknowledgement_record
  (record_id,note_record_id,session_id,acknowledged_at,sightings)
SELECT record_id,note_record_id,session_id,acknowledged_at,sightings
FROM note_acknowledgement;
--> statement-breakpoint
DROP TABLE note_acknowledgement;
DROP TABLE note;
--> statement-breakpoint
ALTER TABLE note_record RENAME TO note;
ALTER TABLE note_acknowledgement_record RENAME TO note_acknowledgement;
--> statement-breakpoint
CREATE INDEX note_project_seen ON note(project, last_seen_at DESC);
CREATE INDEX note_promoted_task_record_id ON note(promoted_task_record_id);
CREATE INDEX note_acknowledgement_session ON note_acknowledgement(session_id, acknowledged_at DESC);
DELETE FROM seq WHERE name='note';

PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
-- newRecordId() is the runtime minter; this is a migration-only random UUID-v4 value.
UPDATE note
SET record_id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
WHERE record_id IS NULL;
--> statement-breakpoint
UPDATE note_acknowledgement
SET record_id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
WHERE record_id IS NULL;
--> statement-breakpoint
CREATE TABLE note_uuid (
  -- Legacy surfaces outside hub still receive this integer, equal to number on every insert.
  id INTEGER PRIMARY KEY,
  record_id TEXT NOT NULL,
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
  UNIQUE(record_id),
  UNIQUE(project, number)
);
--> statement-breakpoint
INSERT INTO note_uuid
  (id,record_id,number,project,text,area,anchors,sightings,created_at,last_seen_at,stale_at,stale_reason,promoted_task,promoted_task_record_id)
SELECT id,record_id,id,project,text,area,anchors,sightings,created_at,last_seen_at,stale_at,stale_reason,promoted_task,promoted_task_record_id
FROM note;
--> statement-breakpoint
CREATE TABLE note_acknowledgement_uuid (
  record_id TEXT NOT NULL PRIMARY KEY,
  note_record_id TEXT NOT NULL REFERENCES note_uuid(record_id) ON UPDATE CASCADE ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  sightings INTEGER NOT NULL CHECK (sightings > 0),
  UNIQUE(note_record_id, session_id)
);
--> statement-breakpoint
INSERT INTO note_acknowledgement_uuid
  (record_id,note_record_id,session_id,acknowledged_at,sightings)
SELECT acknowledgement.record_id,note.record_id,acknowledgement.session_id,
  acknowledgement.acknowledged_at,acknowledgement.sightings
FROM note_acknowledgement acknowledgement
JOIN note ON note.id = acknowledgement.note_id;
--> statement-breakpoint
DROP TABLE note_acknowledgement;
DROP TABLE note;
--> statement-breakpoint
ALTER TABLE note_uuid RENAME TO note;
ALTER TABLE note_acknowledgement_uuid RENAME TO note_acknowledgement;
--> statement-breakpoint
CREATE INDEX note_project_seen ON note(project, last_seen_at DESC);
CREATE INDEX note_promoted_task_record_id ON note(promoted_task_record_id);
CREATE INDEX note_acknowledgement_session ON note_acknowledgement(session_id, acknowledged_at DESC);

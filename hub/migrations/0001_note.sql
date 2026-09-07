CREATE TABLE note (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project       TEXT NOT NULL,
  text          TEXT NOT NULL,
  area          TEXT,
  anchors       TEXT NOT NULL,
  sightings     INTEGER NOT NULL DEFAULT 1 CHECK (sightings > 0),
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  stale_at      TEXT,
  stale_reason  TEXT,
  promoted_task TEXT REFERENCES task(key) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX note_project_seen ON note(project, last_seen_at DESC);
--> statement-breakpoint
INSERT INTO setting (key, value) VALUES ('note.curator.enabled', 'false');
--> statement-breakpoint
INSERT INTO note
  (project, text, area, anchors, sightings, created_at, last_seen_at)
VALUES
  ('bottega', 'Build the curator''s schedule.', 'curator', '[]', 1,
   '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z');

-- A keep is an acknowledgement, not a resolution: it stops this session's
-- reminder while leaving the note open for promotion or another disposition.
-- Session scope is the acknowledgement's expiry, so there is deliberately no
-- TTL column: a future session that never saw the note is never silenced.
-- The sightings snapshot makes the acknowledgement non-sticky. A further
-- sighting is the suggestion box's promotion signal and invalidates the keep.
CREATE TABLE note_acknowledgement (
  note_id         INTEGER NOT NULL REFERENCES note(id) ON DELETE CASCADE,
  session_id      TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  sightings       INTEGER NOT NULL CHECK (sightings > 0),
  PRIMARY KEY (note_id, session_id)
);
--> statement-breakpoint
CREATE INDEX note_acknowledgement_session ON note_acknowledgement(session_id, acknowledged_at DESC);

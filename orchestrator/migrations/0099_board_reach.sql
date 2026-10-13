CREATE TABLE board_reach_recording (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  started_at TEXT NOT NULL
);

INSERT INTO board_reach_recording(singleton,started_at)
VALUES (1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TABLE board_reach_recording_failure (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at TEXT NOT NULL
);

CREATE INDEX board_reach_failure_recorded ON board_reach_recording_failure(recorded_at);

CREATE TABLE board_reach_delivery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_source TEXT NOT NULL CHECK (message_source IN ('local','hosted')),
  message_id TEXT NOT NULL,
  reader_session TEXT NOT NULL,
  reader_project TEXT NOT NULL,
  delivery_point TEXT NOT NULL CHECK (delivery_point IN ('session-start','after-tool-call','stop')),
  blocked_stop INTEGER NOT NULL CHECK (blocked_stop IN (0,1)),
  audience TEXT NOT NULL,
  acknowledgement_required INTEGER NOT NULL CHECK (acknowledgement_required IN (0,1)),
  posted_at TEXT NOT NULL,
  expires_at TEXT,
  session_started_at TEXT NOT NULL,
  posting_timing TEXT NOT NULL CHECK (posting_timing IN ('before-session','after-session')),
  concern TEXT NOT NULL CHECK (concern IN ('concerned','not-concerned','unqualified')),
  recorded_at TEXT NOT NULL
);

CREATE INDEX board_reach_delivery_recorded ON board_reach_delivery(recorded_at);

CREATE TABLE board_reach_delivery_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_source TEXT NOT NULL CHECK (message_source IN ('local','hosted')),
  message_id TEXT NOT NULL,
  reader_session TEXT NOT NULL,
  reader_project TEXT NOT NULL,
  delivery_point TEXT NOT NULL CHECK (delivery_point IN ('session-start','after-tool-call','stop','heartbeat-monitor')),
  blocked_stop INTEGER NOT NULL CHECK (blocked_stop IN (0,1)),
  audience TEXT NOT NULL,
  acknowledgement_required INTEGER NOT NULL CHECK (acknowledgement_required IN (0,1)),
  posted_at TEXT NOT NULL,
  expires_at TEXT,
  session_started_at TEXT NOT NULL,
  posting_timing TEXT NOT NULL CHECK (posting_timing IN ('before-session','after-session')),
  concern TEXT NOT NULL CHECK (concern IN ('concerned','not-concerned','unqualified')),
  recorded_at TEXT NOT NULL,
  emission_id TEXT
);

INSERT INTO board_reach_delivery_next
SELECT id,message_source,message_id,reader_session,reader_project,delivery_point,blocked_stop,
       audience,acknowledgement_required,posted_at,expires_at,session_started_at,posting_timing,
       concern,recorded_at,emission_id
FROM board_reach_delivery;

DROP TABLE board_reach_delivery;
ALTER TABLE board_reach_delivery_next RENAME TO board_reach_delivery;

CREATE INDEX board_reach_delivery_recorded ON board_reach_delivery(recorded_at);
CREATE UNIQUE INDEX board_reach_delivery_emission_message
ON board_reach_delivery(emission_id,message_source,message_id)
WHERE emission_id IS NOT NULL;

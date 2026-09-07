CREATE TABLE contention (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT NOT NULL,
  session_id    TEXT,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN (
                  'trunk','main_checkout','store','cpu','vendor','review','register','lock'
                )),
  resource_key  TEXT NOT NULL,
  event_kind    TEXT NOT NULL CHECK (event_kind IN (
                  'wait','refusal','invalidation','retry','timeout'
                )),
  duration_ms   INTEGER,
  cause         TEXT,
  run_id        INTEGER,
  landing_id    INTEGER
);
--> statement-breakpoint
CREATE INDEX contention_kind_at ON contention(resource_kind, at);
--> statement-breakpoint
CREATE INDEX contention_session_at ON contention(session_id, at);
--> statement-breakpoint
CREATE INDEX contention_landing ON contention(landing_id);

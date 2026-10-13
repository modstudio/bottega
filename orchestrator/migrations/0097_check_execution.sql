CREATE TABLE check_execution (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gate_execution_id INTEGER NOT NULL REFERENCES gate_execution(id) ON DELETE CASCADE,
  check_name TEXT NOT NULL,
  category TEXT,
  wall_ms REAL NOT NULL CHECK (wall_ms >= 0),
  cpu_ms REAL CHECK (cpu_ms IS NULL OR cpu_ms >= 0),
  exit_code INTEGER NOT NULL,
  remaining_count INTEGER CHECK (remaining_count IS NULL OR remaining_count >= 0)
);
--> statement-breakpoint
CREATE INDEX check_execution_category_newest
  ON check_execution(category, gate_execution_id DESC);

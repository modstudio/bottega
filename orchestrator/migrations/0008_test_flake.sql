CREATE TABLE test_flake (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  test TEXT NOT NULL,
  file TEXT NOT NULL,
  load_at_failure TEXT NOT NULL,
  signal TEXT,
  at TEXT NOT NULL,
  CHECK (json_valid(load_at_failure))
);
--> statement-breakpoint
CREATE INDEX test_flake_test_file_at ON test_flake(test, file, at);

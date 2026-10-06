CREATE TABLE main_stack_activity (
  project_id INTEGER PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  last_ensured_at TEXT NOT NULL
);

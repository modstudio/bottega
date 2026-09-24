CREATE TABLE port_ref_new (
  task_key          TEXT NOT NULL,
  target_project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
  note              TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  resolved_at       TEXT,
  PRIMARY KEY (target_project_id, task_key)
);
--> statement-breakpoint
INSERT INTO port_ref_new (task_key,target_project_id,note,created_at,resolved_at)
SELECT task_key,target_project_id,note,created_at,resolved_at FROM port_ref;
--> statement-breakpoint
CREATE TEMP TABLE port_ref_source_before AS
SELECT *, NULL AS target_project_id FROM port_ref_source;
--> statement-breakpoint
UPDATE port_ref_source_before
SET target_project_id=(
  SELECT ref.target_project_id FROM port_ref ref
  WHERE ref.task_key=port_ref_source_before.task_key
);
--> statement-breakpoint
DROP TABLE port_ref_source;
--> statement-breakpoint
DROP TABLE port_ref;
--> statement-breakpoint
ALTER TABLE port_ref_new RENAME TO port_ref;
--> statement-breakpoint
CREATE TABLE port_ref_source (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  task_key          TEXT NOT NULL,
  target_project_id INTEGER NOT NULL,
  source_project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
  commits           TEXT NOT NULL,
  paths             TEXT NOT NULL,
  note              TEXT NOT NULL,
  FOREIGN KEY (target_project_id, task_key)
    REFERENCES port_ref(target_project_id, task_key) ON DELETE CASCADE,
  UNIQUE (target_project_id, task_key, source_project_id)
);
--> statement-breakpoint
INSERT INTO port_ref_source
  (id,task_key,target_project_id,source_project_id,commits,paths,note)
SELECT id,task_key,target_project_id,source_project_id,commits,paths,note
FROM port_ref_source_before;
--> statement-breakpoint
DROP TABLE port_ref_source_before;
--> statement-breakpoint
CREATE INDEX port_ref_source_task ON port_ref_source(target_project_id,task_key);
--> statement-breakpoint
ALTER TABLE run ADD COLUMN task_record_id TEXT;

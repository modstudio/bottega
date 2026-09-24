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
CREATE TABLE port_ref_source_new (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  task_key          TEXT NOT NULL,
  target_project_id INTEGER NOT NULL,
  source_project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
  commits           TEXT NOT NULL,
  paths             TEXT NOT NULL,
  note              TEXT NOT NULL,
  FOREIGN KEY (target_project_id, task_key)
    REFERENCES port_ref_new(target_project_id, task_key) ON DELETE CASCADE,
  UNIQUE (target_project_id, task_key, source_project_id)
);
--> statement-breakpoint
INSERT INTO port_ref_source_new
  (id,task_key,target_project_id,source_project_id,commits,paths,note)
SELECT source.id,source.task_key,ref.target_project_id,source.source_project_id,
       source.commits,source.paths,source.note
FROM port_ref_source source
JOIN port_ref ref ON ref.task_key=source.task_key;
--> statement-breakpoint
DROP TABLE port_ref_source;
--> statement-breakpoint
DROP TABLE port_ref;
--> statement-breakpoint
ALTER TABLE port_ref_new RENAME TO port_ref;
--> statement-breakpoint
ALTER TABLE port_ref_source_new RENAME TO port_ref_source;
--> statement-breakpoint
CREATE INDEX port_ref_source_task ON port_ref_source(target_project_id,task_key);
--> statement-breakpoint
ALTER TABLE run ADD COLUMN task_record_id TEXT;

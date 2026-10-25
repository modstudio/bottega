CREATE TRIGGER run_require_task_or_project_insert
BEFORE INSERT ON run
WHEN NEW.probe = 0
 AND NEW.task_record_id IS NULL
 AND NEW.project_record_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'a run that is not a probe must reference a task or a project; run from a registered project or pass a task key');
END;
--> statement-breakpoint
CREATE TRIGGER run_require_task_or_project_update
BEFORE UPDATE OF task_record_id, project_record_id, probe ON run
WHEN NEW.probe = 0
 AND NEW.task_record_id IS NULL
 AND NEW.project_record_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'a run that is not a probe must reference a task or a project; run from a registered project or pass a task key');
END;

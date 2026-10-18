ALTER TABLE task_comment ADD COLUMN actor_user_id TEXT;
ALTER TABLE task_comment ADD COLUMN actor_name TEXT;
ALTER TABLE task_comment ADD COLUMN agent TEXT;
ALTER TABLE task_comment ADD COLUMN run_id TEXT;
ALTER TABLE task_comment ADD COLUMN updated_at TEXT;
ALTER TABLE task_comment ADD COLUMN deleted_at TEXT;

ALTER TABLE task_status_event ADD COLUMN actor_user_id TEXT;
ALTER TABLE task_status_event ADD COLUMN actor_name TEXT;
ALTER TABLE task_status_event ADD COLUMN agent TEXT;
ALTER TABLE task_status_event ADD COLUMN run_id TEXT;

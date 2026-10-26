CREATE OR REPLACE FUNCTION link_hosted_task_references()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.deleted_at IS NULL THEN
    UPDATE question
    SET workflow_task_id = NEW.id
    WHERE space_id = NEW.space_id
      AND workflow_task_id IS NULL
      AND workflow_key = NEW.key;

    UPDATE operator_waiting_email
    SET task_id = NEW.id
    WHERE space_id = NEW.space_id
      AND task_id IS NULL
      AND task_key = NEW.key;

    UPDATE run
    SET task_id = NEW.id
    WHERE space_id = NEW.space_id
      AND task_id IS NULL
      AND task_key = NEW.key;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER hub_task_link_references_insert
AFTER INSERT ON hub_task
FOR EACH ROW
EXECUTE FUNCTION link_hosted_task_references();
--> statement-breakpoint
CREATE TRIGGER hub_task_link_references_update
AFTER UPDATE OF key, deleted_at ON hub_task
FOR EACH ROW
WHEN (OLD.key IS DISTINCT FROM NEW.key OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
EXECUTE FUNCTION link_hosted_task_references();

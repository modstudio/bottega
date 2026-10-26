CREATE OR REPLACE FUNCTION link_hosted_task_references()
RETURNS trigger
LANGUAGE plpgsql
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
CREATE TRIGGER hub_task_link_references
AFTER INSERT OR UPDATE OF key, deleted_at ON hub_task
FOR EACH ROW
EXECUTE FUNCTION link_hosted_task_references();

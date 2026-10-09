CREATE FUNCTION public.hub_change_append(
  changed_space_id uuid,
  changed_table_name text,
  changed_row_id uuid,
  changed_op text
) RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  next_sequence bigint;
BEGIN
  INSERT INTO public.hub_change_head (space_id, sequence)
  VALUES (changed_space_id, 1)
  ON CONFLICT (space_id) DO UPDATE
  SET sequence = hub_change_head.sequence + 1
  RETURNING sequence INTO next_sequence;

  INSERT INTO public.hub_change (space_id, sequence, table_name, row_id, op)
  VALUES (changed_space_id, next_sequence, changed_table_name, changed_row_id, changed_op);

  RETURN next_sequence;
END
$$;

CREATE FUNCTION public.hub_change_log_row() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.hub_change_append(NEW.space_id, TG_TABLE_NAME, NEW.id, 'upsert');
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM public.hub_change_append(OLD.space_id, TG_TABLE_NAME, OLD.id, 'delete');
    RETURN OLD;
  END IF;

  IF OLD IS NOT DISTINCT FROM NEW THEN
    RETURN NEW;
  END IF;

  IF OLD.space_id = NEW.space_id THEN
    PERFORM public.hub_change_append(NEW.space_id, TG_TABLE_NAME, NEW.id, 'upsert');
  ELSIF OLD.space_id < NEW.space_id THEN
    PERFORM public.hub_change_append(OLD.space_id, TG_TABLE_NAME, OLD.id, 'delete');
    PERFORM public.hub_change_append(NEW.space_id, TG_TABLE_NAME, NEW.id, 'upsert');
  ELSE
    PERFORM public.hub_change_append(NEW.space_id, TG_TABLE_NAME, NEW.id, 'upsert');
    PERFORM public.hub_change_append(OLD.space_id, TG_TABLE_NAME, OLD.id, 'delete');
  END IF;

  RETURN NEW;
END
$$;

CREATE FUNCTION public.hub_change_log_send_recipient() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  recipient record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    recipient := OLD;
  ELSE
    recipient := NEW;
  END IF;

  PERFORM public.hub_change_append(
    recipient.space_id,
    'hub_send',
    recipient.send_id,
    'upsert'
  );
  RETURN recipient;
END
$$;

CREATE TRIGGER hub_task_change_log
AFTER INSERT OR UPDATE OR DELETE ON public.hub_task
FOR EACH ROW EXECUTE FUNCTION public.hub_change_log_row();
CREATE TRIGGER hub_task_comment_change_log
AFTER INSERT OR UPDATE OR DELETE ON public.hub_task_comment
FOR EACH ROW EXECUTE FUNCTION public.hub_change_log_row();
CREATE TRIGGER hub_task_document_change_log
AFTER INSERT OR UPDATE OR DELETE ON public.hub_task_document
FOR EACH ROW EXECUTE FUNCTION public.hub_change_log_row();
CREATE TRIGGER hub_task_status_event_change_log
AFTER INSERT OR UPDATE OR DELETE ON public.hub_task_status_event
FOR EACH ROW EXECUTE FUNCTION public.hub_change_log_row();
CREATE TRIGGER hub_send_change_log
AFTER INSERT OR UPDATE OR DELETE ON public.hub_send
FOR EACH ROW EXECUTE FUNCTION public.hub_change_log_row();
CREATE TRIGGER hub_interval_change_log
AFTER INSERT OR UPDATE OR DELETE ON public.hub_interval
FOR EACH ROW EXECUTE FUNCTION public.hub_change_log_row();
CREATE TRIGGER hub_day_change_log
AFTER INSERT OR UPDATE OR DELETE ON public.hub_day
FOR EACH ROW EXECUTE FUNCTION public.hub_change_log_row();
CREATE TRIGGER hub_note_change_log
AFTER INSERT OR UPDATE OR DELETE ON public.hub_note
FOR EACH ROW EXECUTE FUNCTION public.hub_change_log_row();
CREATE TRIGGER hub_note_acknowledgement_change_log
AFTER INSERT OR UPDATE OR DELETE ON public.hub_note_acknowledgement
FOR EACH ROW EXECUTE FUNCTION public.hub_change_log_row();
CREATE TRIGGER hub_send_recipient_change_log
AFTER INSERT OR UPDATE OR DELETE ON public.hub_send_recipient
FOR EACH ROW EXECUTE FUNCTION public.hub_change_log_send_recipient();

ALTER TABLE public.hub_change_head FORCE ROW LEVEL SECURITY;
ALTER TABLE public.hub_change FORCE ROW LEVEL SECURITY;

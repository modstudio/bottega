DROP TRIGGER hub_task_change_log ON public.hub_task;
DROP TRIGGER hub_task_comment_change_log ON public.hub_task_comment;
DROP TRIGGER hub_task_document_change_log ON public.hub_task_document;
DROP TRIGGER hub_task_status_event_change_log ON public.hub_task_status_event;
DROP TRIGGER hub_send_change_log ON public.hub_send;
DROP TRIGGER hub_interval_change_log ON public.hub_interval;
DROP TRIGGER hub_day_change_log ON public.hub_day;
DROP TRIGGER hub_note_change_log ON public.hub_note;
DROP TRIGGER hub_note_acknowledgement_change_log ON public.hub_note_acknowledgement;
DROP TRIGGER hub_send_recipient_change_log ON public.hub_send_recipient;

DROP TRIGGER record_change_hub_interval ON public.hub_interval;
DROP TRIGGER record_change_hub_day ON public.hub_day;
DROP TRIGGER record_change_doc_revision ON public.doc_revision;
DROP TRIGGER record_change_hub_send_recipient ON public.hub_send_recipient;

CREATE TRIGGER record_change_hub_send_recipient
AFTER INSERT OR UPDATE OR DELETE ON public.hub_send_recipient
FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row('send_id','hub_send');

DROP FUNCTION public.hub_change_append(uuid, text, uuid, text);
DROP FUNCTION public.hub_change_log_row();
DROP FUNCTION public.hub_change_log_send_recipient();
DROP FUNCTION public.hub_change_prune();

DO $$
DECLARE
  definition text;
  previous text := '(''hub_change'',''space''),(''hub_change_head'',''space''),(''hub_day'',''space''),';
  replacement text := '(''hub_day'',''space''),';
BEGIN
  SELECT pg_get_functiondef('public.record_move_project_space(text,text,text,bigint)'::regprocedure)
  INTO definition;
  IF position(previous IN definition) = 0 THEN
    RAISE EXCEPTION 'record_move_project_space classification anchor is absent';
  END IF;
  definition := replace(definition, previous, replacement);
  EXECUTE definition;
END
$$;

ALTER TABLE public.record_change FORCE ROW LEVEL SECURITY;
ALTER TABLE public.record_change_horizon FORCE ROW LEVEL SECURITY;

INSERT INTO public.record_change_horizon (singleton, seq) VALUES (true, 0);

CREATE FUNCTION public.record_change_log_row() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  old_row jsonb;
  new_row jsonb;
  row_id_column text := COALESCE(TG_ARGV[0], 'id');
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_row := to_jsonb(OLD);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_row := to_jsonb(NEW);
  END IF;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.record_change (space_id, table_name, row_id, op)
    VALUES ((new_row->>'space_id')::uuid, TG_TABLE_NAME, (new_row->>row_id_column)::uuid, 'upsert');
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.record_change (space_id, table_name, row_id, op)
    VALUES ((old_row->>'space_id')::uuid, TG_TABLE_NAME, (old_row->>row_id_column)::uuid, 'delete');
    RETURN OLD;
  END IF;

  IF OLD IS NOT DISTINCT FROM NEW THEN
    RETURN NEW;
  END IF;

  IF old_row->>'space_id' IS DISTINCT FROM new_row->>'space_id' THEN
    INSERT INTO public.record_change (space_id, table_name, row_id, op)
    VALUES ((old_row->>'space_id')::uuid, TG_TABLE_NAME, (old_row->>row_id_column)::uuid, 'delete');
  END IF;
  INSERT INTO public.record_change (space_id, table_name, row_id, op)
  VALUES ((new_row->>'space_id')::uuid, TG_TABLE_NAME, (new_row->>row_id_column)::uuid, 'upsert');
  RETURN NEW;
END
$$;

CREATE TRIGGER record_change_hub_task AFTER INSERT OR UPDATE OR DELETE ON public.hub_task FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_hub_task_comment AFTER INSERT OR UPDATE OR DELETE ON public.hub_task_comment FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_hub_task_document AFTER INSERT OR UPDATE OR DELETE ON public.hub_task_document FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_hub_task_status_event AFTER INSERT OR UPDATE OR DELETE ON public.hub_task_status_event FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_hub_send AFTER INSERT OR UPDATE OR DELETE ON public.hub_send FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_hub_interval AFTER INSERT OR UPDATE OR DELETE ON public.hub_interval FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_hub_day AFTER INSERT OR UPDATE OR DELETE ON public.hub_day FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_hub_note AFTER INSERT OR UPDATE OR DELETE ON public.hub_note FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_hub_note_acknowledgement AFTER INSERT OR UPDATE OR DELETE ON public.hub_note_acknowledgement FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_hub_send_recipient AFTER INSERT OR UPDATE OR DELETE ON public.hub_send_recipient FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_doc AFTER INSERT OR UPDATE OR DELETE ON public.doc FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_doc_revision AFTER INSERT OR UPDATE OR DELETE ON public.doc_revision FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_doc_related_subject AFTER INSERT OR UPDATE OR DELETE ON public.doc_related_subject FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_subject AFTER INSERT OR UPDATE OR DELETE ON public.subject FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_project AFTER INSERT OR UPDATE OR DELETE ON public.project FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_lens AFTER INSERT OR UPDATE OR DELETE ON public.lens FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_lens_revision AFTER INSERT OR UPDATE OR DELETE ON public.lens_revision FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_lens_profile AFTER INSERT OR UPDATE OR DELETE ON public.lens_profile FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_lens_profile_revision AFTER INSERT OR UPDATE OR DELETE ON public.lens_profile_revision FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_project_lens_profile AFTER INSERT OR UPDATE OR DELETE ON public.project_lens_profile FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_project_lens_profile_revision AFTER INSERT OR UPDATE OR DELETE ON public.project_lens_profile_revision FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_port_doctrine AFTER INSERT OR UPDATE OR DELETE ON public.port_doctrine FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_port_pair AFTER INSERT OR UPDATE OR DELETE ON public.port_pair FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_port_baseline AFTER INSERT OR UPDATE OR DELETE ON public.port_baseline FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_port_ref AFTER INSERT OR UPDATE OR DELETE ON public.port_ref FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_port_ref_source AFTER INSERT OR UPDATE OR DELETE ON public.port_ref_source FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_port_skip AFTER INSERT OR UPDATE OR DELETE ON public.port_skip FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_workflow AFTER INSERT OR UPDATE OR DELETE ON public.workflow FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_workflow_version AFTER INSERT OR UPDATE OR DELETE ON public.workflow_version FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_workflow_event AFTER INSERT OR UPDATE OR DELETE ON public.workflow_event FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_step_catalogue AFTER INSERT OR UPDATE OR DELETE ON public.step_catalogue FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_step_catalogue_version AFTER INSERT OR UPDATE OR DELETE ON public.step_catalogue_version FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_step_catalogue_event AFTER INSERT OR UPDATE OR DELETE ON public.step_catalogue_event FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_run AFTER INSERT OR UPDATE OR DELETE ON public.run FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_review_lens AFTER INSERT OR UPDATE OR DELETE ON public.review_lens FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row();
CREATE TRIGGER record_change_run_score AFTER INSERT OR UPDATE OR DELETE ON public.run_score FOR EACH ROW EXECUTE FUNCTION public.record_change_log_row('run_id');

CREATE FUNCTION public.record_change_prune() RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  retention CONSTANT interval := interval '30 days';
  deleted_count bigint;
  pruned_horizon bigint;
BEGIN
  WITH deleted AS (
    DELETE FROM public.record_change
    WHERE at < now() - retention
    RETURNING seq
  )
  SELECT count(*), max(seq) INTO deleted_count, pruned_horizon FROM deleted;

  IF pruned_horizon IS NOT NULL THEN
    UPDATE public.record_change_horizon
    SET seq = greatest(seq, pruned_horizon)
    WHERE singleton;
  END IF;
  RETURN deleted_count;
END
$$;

ALTER FUNCTION public.record_change_prune() OWNER TO record_owner;
REVOKE ALL ON FUNCTION public.record_change_prune() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_change_prune() TO record_actor;

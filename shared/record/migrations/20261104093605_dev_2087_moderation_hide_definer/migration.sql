DROP POLICY "hub_note_outside_author_select" ON public.hub_note;
CREATE POLICY "hub_note_outside_author_select" ON public.hub_note
AS PERMISSIVE FOR SELECT TO record_actor
USING (
  author_user_id = nullif(current_setting('app.user_id', true), '')::uuid
  AND NOT EXISTS (
    SELECT 1 FROM public.membership m
    WHERE m.space_id = hub_note.space_id
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
  )
);

CREATE OR REPLACE FUNCTION public.board_message_set_hidden(
  p_message_id uuid,
  p_reason text,
  p_actor_id uuid
)
RETURNS TABLE(
  id uuid,
  author_user_id uuid,
  hidden_at timestamptz,
  hidden_by_user_id uuid,
  hidden_reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  active_space_id uuid := nullif(current_setting('app.space_id', true), '')::uuid;
BEGIN
  IF actor_id IS NULL OR actor_id IS DISTINCT FROM p_actor_id THEN
    RAISE EXCEPTION 'board moderation actor must be the signed-in user';
  END IF;
  IF active_space_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.membership m
    WHERE m.space_id = active_space_id AND m.user_id = actor_id AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'board moderation requires the active space owner';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.board_message message
    JOIN LATERAL unnest(message.scope_project_ids) scoped(project_id) ON true
    JOIN public.project project ON project.id = scoped.project_id
    WHERE message.id = p_message_id AND project.space_id = active_space_id
  ) THEN
    RAISE EXCEPTION 'board message is outside the active space';
  END IF;

  RETURN QUERY
  UPDATE public.board_message message
  SET hidden_at = CASE WHEN p_reason IS NULL THEN NULL ELSE now() END,
      hidden_by_user_id = CASE WHEN p_reason IS NULL THEN NULL ELSE actor_id END,
      hidden_reason = p_reason
  WHERE message.id = p_message_id
  RETURNING message.id,message.author_user_id,message.hidden_at,
    message.hidden_by_user_id,message.hidden_reason;
END;
$$;

ALTER FUNCTION public.board_message_set_hidden(uuid,text,uuid) OWNER TO record_owner;
REVOKE ALL ON FUNCTION public.board_message_set_hidden(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.board_message_set_hidden(uuid,text,uuid) TO record_actor;

CREATE OR REPLACE FUNCTION public.hub_note_set_hidden(
  p_note_id uuid,
  p_reason text,
  p_actor_id uuid
)
RETURNS TABLE(
  id uuid,
  project_name text,
  number bigint,
  author_user_id uuid,
  hidden_at timestamptz,
  hidden_by_user_id uuid,
  hidden_reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  active_space_id uuid := nullif(current_setting('app.space_id', true), '')::uuid;
BEGIN
  IF actor_id IS NULL OR actor_id IS DISTINCT FROM p_actor_id THEN
    RAISE EXCEPTION 'note moderation actor must be the signed-in user';
  END IF;
  IF active_space_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.membership m
    WHERE m.space_id = active_space_id AND m.user_id = actor_id AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'note moderation requires the active space owner';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.hub_note note
    WHERE note.id = p_note_id AND note.space_id = active_space_id
  ) THEN
    RAISE EXCEPTION 'note is outside the active space';
  END IF;

  RETURN QUERY
  UPDATE public.hub_note note
  SET hidden_at = CASE WHEN p_reason IS NULL THEN NULL ELSE now() END,
      hidden_by_user_id = CASE WHEN p_reason IS NULL THEN NULL ELSE actor_id END,
      hidden_reason = p_reason
  WHERE note.id = p_note_id
  RETURNING note.id,note.project_name,note.number,note.author_user_id,note.hidden_at,
    note.hidden_by_user_id,note.hidden_reason;
END;
$$;

ALTER FUNCTION public.hub_note_set_hidden(uuid,text,uuid) OWNER TO record_owner;
REVOKE ALL ON FUNCTION public.hub_note_set_hidden(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hub_note_set_hidden(uuid,text,uuid) TO record_actor;

CREATE OR REPLACE FUNCTION public.record_reject_direct_hidden_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF current_user <> 'record_owner' THEN
    IF TG_OP = 'INSERT' AND (
      NEW.hidden_at IS NOT NULL OR
      NEW.hidden_by_user_id IS NOT NULL OR
      NEW.hidden_reason IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'hidden fields may only be changed through owner moderation';
    ELSIF TG_OP = 'UPDATE' AND (
      NEW.hidden_at IS DISTINCT FROM OLD.hidden_at OR
      NEW.hidden_by_user_id IS DISTINCT FROM OLD.hidden_by_user_id OR
      NEW.hidden_reason IS DISTINCT FROM OLD.hidden_reason
    ) THEN
      RAISE EXCEPTION 'hidden fields may only be changed through owner moderation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.record_reject_direct_hidden_update() OWNER TO record_owner;
REVOKE ALL ON FUNCTION public.record_reject_direct_hidden_update() FROM PUBLIC;

CREATE TRIGGER board_message_hidden_update_guard
BEFORE INSERT OR UPDATE OF hidden_at,hidden_by_user_id,hidden_reason ON public.board_message
FOR EACH ROW EXECUTE FUNCTION public.record_reject_direct_hidden_update();

CREATE TRIGGER hub_note_hidden_update_guard
BEFORE INSERT OR UPDATE OF hidden_at,hidden_by_user_id,hidden_reason ON public.hub_note
FOR EACH ROW EXECUTE FUNCTION public.record_reject_direct_hidden_update();

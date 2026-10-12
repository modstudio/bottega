ALTER TABLE "board_message" ADD COLUMN "shared_space_reach" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "board_message" ADD CONSTRAINT "board_message_shared_space_reach_check" CHECK (("kind" = 'reply' OR "shared_space_reach" = ("audience" = 'spaces'))
          AND (NOT "shared_space_reach" OR
            (cardinality("scope_project_ids") = 0
              AND cardinality("recipient_user_ids") = 0)));--> statement-breakpoint
CREATE POLICY "membership_owner_select" ON "membership" AS PERMISSIVE FOR SELECT TO "record_owner" USING (true);--> statement-breakpoint
CREATE FUNCTION public.record_board_author_shares_space(target_author_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.membership reader
    JOIN public.membership author ON author.space_id = reader.space_id
    WHERE reader.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND author.user_id = target_author_user_id
  )
$$;--> statement-breakpoint
ALTER FUNCTION public.record_board_author_shares_space(uuid) OWNER TO record_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_board_author_shares_space(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_board_author_shares_space(uuid) TO record_actor;--> statement-breakpoint
ALTER POLICY "board_message_actor_select" ON "board_message" TO "record_actor" USING ("board_message"."author_user_id" = nullif(current_setting('app.user_id', true), '')::uuid OR
      ("board_message"."shared_space_reach" AND record_board_author_shares_space("board_message"."author_user_id")) OR
      (cardinality("board_message"."scope_project_ids") > 0 AND NOT EXISTS (
    SELECT 1 FROM unnest("board_message"."scope_project_ids") AS scoped(project_id)
    WHERE NOT EXISTS (
      SELECT 1 FROM "project" p
      JOIN "membership" m ON m.space_id = p.space_id
      WHERE p.id = scoped.project_id AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
    )
  )) OR
      (nullif(current_setting('app.user_id', true), '')::uuid = ANY("board_message"."recipient_user_ids") AND NOT EXISTS (
    SELECT 1 FROM unnest("board_message"."scope_project_ids") AS scoped(project_id)
    WHERE NOT EXISTS (
      SELECT 1 FROM "project" p
      JOIN "membership" m ON m.space_id = p.space_id
      WHERE p.id = scoped.project_id AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
    )
  )));--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.board_message_validate_reply() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  root_scope_project_ids uuid[];
  root_recipient_user_ids uuid[];
  root_shared_space_reach boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.shared_space_reach IS DISTINCT FROM OLD.shared_space_reach THEN
    RAISE EXCEPTION 'board message shared-space reach cannot change after posting';
  END IF;

  IF NEW.kind = 'reply' THEN
    SELECT scope_project_ids, recipient_user_ids, shared_space_reach
      INTO root_scope_project_ids, root_recipient_user_ids, root_shared_space_reach
      FROM public.board_message
      WHERE id = NEW.thread_root_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'board reply thread root is not visible';
    END IF;
    IF root_scope_project_ids <> NEW.scope_project_ids
      OR root_recipient_user_ids <> NEW.recipient_user_ids
      OR root_shared_space_reach <> NEW.shared_space_reach THEN
      RAISE EXCEPTION 'board reply scope and recipients must match thread root, including shared-space reach';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

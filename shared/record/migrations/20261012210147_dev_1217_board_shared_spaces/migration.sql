ALTER TABLE "board_message" ADD COLUMN "shared_space_reach" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "board_message" ADD COLUMN "thread_root_author_user_id" uuid;--> statement-breakpoint
ALTER TABLE "board_message" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE
  reply_to_reply_count bigint;
BEGIN
  SELECT count(*) INTO reply_to_reply_count
  FROM "board_message" AS reply
  JOIN "board_message" AS root ON root."id" = reply."thread_root_id"
  WHERE reply."kind" = 'reply' AND root."kind" = 'reply';

  IF reply_to_reply_count > 0 THEN
    RAISE EXCEPTION 'board message migration found % replies whose thread_root_id names a reply',
      reply_to_reply_count;
  END IF;
END
$$;--> statement-breakpoint
UPDATE "board_message" AS message
SET "thread_root_author_user_id" = CASE
  WHEN message."kind" = 'reply' THEN (
    SELECT root."author_user_id"
    FROM "board_message" AS root
    WHERE root."id" = message."thread_root_id"
  )
  ELSE message."author_user_id"
END;--> statement-breakpoint
ALTER TABLE "board_message" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "board_message" ALTER COLUMN "thread_root_author_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "board_message" ADD CONSTRAINT "board_message_thread_root_author_user_id_user_id_fkey" FOREIGN KEY ("thread_root_author_user_id") REFERENCES "user"("id");--> statement-breakpoint
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
      ("board_message"."shared_space_reach" AND record_board_author_shares_space("board_message"."thread_root_author_user_id")) OR
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
  root_author_user_id uuid;
  root_kind text;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.thread_root_author_user_id IS NOT NULL THEN
    RAISE EXCEPTION 'board message thread-root author is set by the database';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'board message kind cannot change after posting';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.thread_root_id IS DISTINCT FROM OLD.thread_root_id THEN
    RAISE EXCEPTION 'board message thread_root_id cannot change after posting';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.author_user_id IS DISTINCT FROM OLD.author_user_id THEN
    RAISE EXCEPTION 'board message author_user_id cannot change after posting';
  END IF;

  IF TG_OP = 'UPDATE'
    AND NEW.thread_root_author_user_id IS DISTINCT FROM OLD.thread_root_author_user_id THEN
    RAISE EXCEPTION 'board message thread_root_author_user_id cannot change after posting';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.shared_space_reach IS DISTINCT FROM OLD.shared_space_reach THEN
    RAISE EXCEPTION 'board message shared_space_reach cannot change after posting';
  END IF;

  IF NEW.kind = 'reply' THEN
    SELECT scope_project_ids, recipient_user_ids, shared_space_reach,
        thread_root_author_user_id, kind
      INTO root_scope_project_ids, root_recipient_user_ids, root_shared_space_reach,
        root_author_user_id, root_kind
      FROM public.board_message
      WHERE id = NEW.thread_root_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'board reply thread root is not visible';
    END IF;
    IF root_kind = 'reply' THEN
      RAISE EXCEPTION 'board reply thread_root_id must name a row that is not a reply';
    END IF;
    IF root_scope_project_ids <> NEW.scope_project_ids
      OR root_recipient_user_ids <> NEW.recipient_user_ids
      OR root_shared_space_reach <> NEW.shared_space_reach THEN
      RAISE EXCEPTION 'board reply scope and recipients must match thread root, including shared-space reach';
    END IF;
    NEW.thread_root_author_user_id := root_author_user_id;
  ELSIF TG_OP = 'INSERT' THEN
    NEW.thread_root_author_user_id := NEW.author_user_id;
  END IF;
  RETURN NEW;
END
$$;

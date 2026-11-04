CREATE TABLE "space_outside_intake" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL CONSTRAINT "space_outside_intake_space_unique" UNIQUE,
	"project_id" uuid NOT NULL,
	"paused_until" timestamp with time zone,
	"paused_by_user_id" uuid,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "space_outside_intake" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "space_outside_write" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "space_outside_write_kind_check" CHECK ("kind" IN ('post','reply','note'))
);
--> statement-breakpoint
ALTER TABLE "space_outside_write" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "space_posting_block" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"blocked_until" timestamp with time zone,
	"blocked_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "space_posting_block_space_user_unique" UNIQUE("space_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "space_posting_block" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "space_outside_write_user_created_idx" ON "space_outside_write" ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "space_outside_intake" ADD CONSTRAINT "space_outside_intake_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "space_outside_intake" ADD CONSTRAINT "space_outside_intake_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
ALTER TABLE "space_outside_intake" ADD CONSTRAINT "space_outside_intake_paused_by_user_id_user_id_fkey" FOREIGN KEY ("paused_by_user_id") REFERENCES "user"("id");--> statement-breakpoint
ALTER TABLE "space_outside_intake" ADD CONSTRAINT "space_outside_intake_space_project_fk" FOREIGN KEY ("space_id","project_id") REFERENCES "project"("space_id","id") ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "space_outside_write" ADD CONSTRAINT "space_outside_write_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "space_outside_write" ADD CONSTRAINT "space_outside_write_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id");--> statement-breakpoint
ALTER TABLE "space_posting_block" ADD CONSTRAINT "space_posting_block_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "space_posting_block" ADD CONSTRAINT "space_posting_block_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id");--> statement-breakpoint
ALTER TABLE "space_posting_block" ADD CONSTRAINT "space_posting_block_blocked_by_user_id_user_id_fkey" FOREIGN KEY ("blocked_by_user_id") REFERENCES "user"("id");--> statement-breakpoint
CREATE POLICY "board_message_owner_insert" ON "board_message" AS PERMISSIVE FOR INSERT TO "record_owner" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "space_outside_intake_actor_select" ON "space_outside_intake" AS PERMISSIVE FOR SELECT TO "record_actor" USING (EXISTS (
  SELECT 1 FROM "membership" m
  WHERE m.space_id = "space_outside_intake"."space_id" AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
));--> statement-breakpoint
CREATE POLICY "space_outside_intake_actor_insert" ON "space_outside_intake" AS PERMISSIVE FOR INSERT TO "record_actor" WITH CHECK (EXISTS (
  SELECT 1 FROM "membership" m
  WHERE m.space_id = "space_outside_intake"."space_id" AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid AND m.role = 'owner'
));--> statement-breakpoint
CREATE POLICY "space_outside_intake_actor_update" ON "space_outside_intake" AS PERMISSIVE FOR UPDATE TO "record_actor" USING (EXISTS (
  SELECT 1 FROM "membership" m
  WHERE m.space_id = "space_outside_intake"."space_id" AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid AND m.role = 'owner'
)) WITH CHECK (EXISTS (
  SELECT 1 FROM "membership" m
  WHERE m.space_id = "space_outside_intake"."space_id" AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid AND m.role = 'owner'
));--> statement-breakpoint
CREATE POLICY "space_outside_intake_actor_delete" ON "space_outside_intake" AS PERMISSIVE FOR DELETE TO "record_actor" USING (EXISTS (
  SELECT 1 FROM "membership" m
  WHERE m.space_id = "space_outside_intake"."space_id" AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid AND m.role = 'owner'
));--> statement-breakpoint
CREATE POLICY "space_outside_intake_owner_select" ON "space_outside_intake" AS PERMISSIVE FOR SELECT TO "record_owner" USING (true);--> statement-breakpoint
CREATE POLICY "space_outside_write_actor_select" ON "space_outside_write" AS PERMISSIVE FOR SELECT TO "record_actor" USING ("space_outside_write"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "space_outside_write_owner_insert" ON "space_outside_write" AS PERMISSIVE FOR INSERT TO "record_owner" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "space_posting_block_actor_select" ON "space_posting_block" AS PERMISSIVE FOR SELECT TO "record_actor" USING (EXISTS (
  SELECT 1 FROM "membership" m
  WHERE m.space_id = "space_posting_block"."space_id" AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid AND m.role = 'owner'
));--> statement-breakpoint
CREATE POLICY "space_posting_block_actor_insert" ON "space_posting_block" AS PERMISSIVE FOR INSERT TO "record_actor" WITH CHECK (EXISTS (
  SELECT 1 FROM "membership" m
  WHERE m.space_id = "space_posting_block"."space_id" AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid AND m.role = 'owner'
));--> statement-breakpoint
CREATE POLICY "space_posting_block_actor_update" ON "space_posting_block" AS PERMISSIVE FOR UPDATE TO "record_actor" USING (EXISTS (
  SELECT 1 FROM "membership" m
  WHERE m.space_id = "space_posting_block"."space_id" AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid AND m.role = 'owner'
)) WITH CHECK (EXISTS (
  SELECT 1 FROM "membership" m
  WHERE m.space_id = "space_posting_block"."space_id" AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid AND m.role = 'owner'
));--> statement-breakpoint
CREATE POLICY "space_posting_block_actor_delete" ON "space_posting_block" AS PERMISSIVE FOR DELETE TO "record_actor" USING (EXISTS (
  SELECT 1 FROM "membership" m
  WHERE m.space_id = "space_posting_block"."space_id" AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid AND m.role = 'owner'
));--> statement-breakpoint
CREATE POLICY "space_posting_block_owner_select" ON "space_posting_block" AS PERMISSIVE FOR SELECT TO "record_owner" USING (true);--> statement-breakpoint
ALTER POLICY "board_message_actor_select" ON "board_message" TO "record_actor" USING ("board_message"."author_user_id" = nullif(current_setting('app.user_id', true), '')::uuid OR
      "board_message"."thread_root_author_user_id" = nullif(current_setting('app.user_id', true), '')::uuid OR
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
  )));
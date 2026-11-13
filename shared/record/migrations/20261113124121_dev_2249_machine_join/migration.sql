CREATE TABLE "machine_join_message" (
	"id" uuid PRIMARY KEY,
	"nameplate_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"side" text NOT NULL,
	"phase" text NOT NULL,
	"body" bytea NOT NULL,
	"posted_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "machine_join_message_nameplate_side_phase_unique" UNIQUE("nameplate_id","side","phase"),
	CONSTRAINT "machine_join_message_side_check" CHECK ("side" ~ '^[0-9a-f]{32}$'),
	CONSTRAINT "machine_join_message_phase_check" CHECK ("phase" ~ '^[a-z0-9-]{1,32}$'),
	CONSTRAINT "machine_join_message_body_check" CHECK (octet_length("body") BETWEEN 1 AND 4096)
);
--> statement-breakpoint
ALTER TABLE "machine_join_message" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "machine_join_nameplate" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"nameplate" text NOT NULL,
	"allocated_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"failed_at" timestamp with time zone,
	"failed_by" uuid,
	CONSTRAINT "machine_join_nameplate_space_nameplate_unique" UNIQUE("space_id","nameplate"),
	CONSTRAINT "machine_join_nameplate_nameplate_check" CHECK ("nameplate" ~ '^[1-9][0-9]{0,5}$')
);
--> statement-breakpoint
ALTER TABLE "machine_join_nameplate" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "machine_join_message" ADD CONSTRAINT "machine_join_message_9Dn1rR023xXn_fkey" FOREIGN KEY ("nameplate_id") REFERENCES "machine_join_nameplate"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "machine_join_message" ADD CONSTRAINT "machine_join_message_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "machine_join_message" ADD CONSTRAINT "machine_join_message_posted_by_user_id_fkey" FOREIGN KEY ("posted_by") REFERENCES "user"("id");--> statement-breakpoint
ALTER TABLE "machine_join_nameplate" ADD CONSTRAINT "machine_join_nameplate_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "machine_join_nameplate" ADD CONSTRAINT "machine_join_nameplate_allocated_by_user_id_fkey" FOREIGN KEY ("allocated_by") REFERENCES "user"("id");--> statement-breakpoint
ALTER TABLE "machine_join_nameplate" ADD CONSTRAINT "machine_join_nameplate_failed_by_user_id_fkey" FOREIGN KEY ("failed_by") REFERENCES "user"("id");--> statement-breakpoint
CREATE POLICY "machine_join_message_space_select" ON "machine_join_message" AS PERMISSIVE FOR SELECT TO public USING ("machine_join_message"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "machine_join_message"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "machine_join_message_space_insert" ON "machine_join_message" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("machine_join_message"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "machine_join_message"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "machine_join_message_owner_select" ON "machine_join_message" AS PERMISSIVE FOR SELECT TO "record_owner" USING (true);--> statement-breakpoint
CREATE POLICY "machine_join_message_owner_delete" ON "machine_join_message" AS PERMISSIVE FOR DELETE TO "record_owner" USING (true);--> statement-breakpoint
CREATE POLICY "machine_join_nameplate_space_select" ON "machine_join_nameplate" AS PERMISSIVE FOR SELECT TO public USING ("machine_join_nameplate"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "machine_join_nameplate"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "machine_join_nameplate_space_insert" ON "machine_join_nameplate" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("machine_join_nameplate"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "machine_join_nameplate"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "machine_join_nameplate_space_update" ON "machine_join_nameplate" AS PERMISSIVE FOR UPDATE TO public USING (("machine_join_nameplate"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "machine_join_nameplate"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("machine_join_nameplate"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "machine_join_nameplate"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "machine_join_nameplate_owner_select" ON "machine_join_nameplate" AS PERMISSIVE FOR SELECT TO "record_owner" USING (true);--> statement-breakpoint
CREATE POLICY "machine_join_nameplate_owner_delete" ON "machine_join_nameplate" AS PERMISSIVE FOR DELETE TO "record_owner" USING (true);
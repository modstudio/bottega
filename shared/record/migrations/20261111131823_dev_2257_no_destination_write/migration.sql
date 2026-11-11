CREATE TABLE "no_destination_write" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"route" text NOT NULL,
	"cause" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "no_destination_write" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "no_destination_write_at_idx" ON "no_destination_write" ("at");--> statement-breakpoint
ALTER TABLE "no_destination_write" ADD CONSTRAINT "no_destination_write_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
CREATE POLICY "no_destination_write_space_select" ON "no_destination_write" AS PERMISSIVE FOR SELECT TO public USING ("no_destination_write"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "no_destination_write"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "no_destination_write_space_insert" ON "no_destination_write" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("no_destination_write"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "no_destination_write"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "no_destination_write_space_update" ON "no_destination_write" AS PERMISSIVE FOR UPDATE TO public USING (("no_destination_write"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "no_destination_write"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("no_destination_write"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "no_destination_write"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "no_destination_write_space_delete" ON "no_destination_write" AS PERMISSIVE FOR DELETE TO public USING (("no_destination_write"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "no_destination_write"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "no_destination_write_owner_all" ON "no_destination_write" AS PERMISSIVE FOR ALL TO "record_owner" USING (true) WITH CHECK (true);
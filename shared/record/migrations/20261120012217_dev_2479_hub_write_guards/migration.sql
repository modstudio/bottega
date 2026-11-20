CREATE TABLE "hub_applied_change" (
	"change_id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"result" jsonb NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hub_applied_change" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hub_note" ADD COLUMN "revision" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "hub_task" ADD COLUMN "revision" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "hub_task_comment" ADD COLUMN "revision" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "hub_applied_change_applied_at_idx" ON "hub_applied_change" ("applied_at");--> statement-breakpoint
ALTER TABLE "hub_applied_change" ADD CONSTRAINT "hub_applied_change_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
CREATE POLICY "hub_applied_change_space_select" ON "hub_applied_change" AS PERMISSIVE FOR SELECT TO public USING ("hub_applied_change"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "hub_applied_change"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "hub_applied_change_space_insert" ON "hub_applied_change" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("hub_applied_change"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "hub_applied_change"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "hub_applied_change_space_update" ON "hub_applied_change" AS PERMISSIVE FOR UPDATE TO public USING (("hub_applied_change"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "hub_applied_change"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("hub_applied_change"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "hub_applied_change"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "hub_applied_change_space_delete" ON "hub_applied_change" AS PERMISSIVE FOR DELETE TO public USING (("hub_applied_change"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "hub_applied_change"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "hub_applied_change_owner_all" ON "hub_applied_change" AS PERMISSIVE FOR ALL TO "record_owner" USING (true) WITH CHECK (true);
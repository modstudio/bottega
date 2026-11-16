CREATE TABLE "hook_emission" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"event" text NOT NULL,
	"hook" text NOT NULL,
	"kind" text NOT NULL,
	"chars" integer NOT NULL,
	"lines" integer NOT NULL,
	"text_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hook_emission_kind_check" CHECK ("kind" IN ('additionalContext','systemMessage','blockReason','denyReason','allowReason','askReason')),
	CONSTRAINT "hook_emission_chars_check" CHECK ("chars" >= 0),
	CONSTRAINT "hook_emission_lines_check" CHECK ("lines" >= 0)
);
--> statement-breakpoint
ALTER TABLE "hook_emission" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "hook_emission_session_at_idx" ON "hook_emission" ("session_id","at");--> statement-breakpoint
ALTER TABLE "hook_emission" ADD CONSTRAINT "hook_emission_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "hook_emission" ADD CONSTRAINT "hook_emission_machine_id_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machine"("id");--> statement-breakpoint
CREATE POLICY "hook_emission_space_select" ON "hook_emission" AS PERMISSIVE FOR SELECT TO public USING ("hook_emission"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "hook_emission"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "hook_emission_space_insert" ON "hook_emission" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("hook_emission"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "hook_emission"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "hook_emission_space_update" ON "hook_emission" AS PERMISSIVE FOR UPDATE TO public USING (("hook_emission"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "hook_emission"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("hook_emission"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "hook_emission"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "hook_emission_space_delete" ON "hook_emission" AS PERMISSIVE FOR DELETE TO public USING (("hook_emission"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "hook_emission"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));
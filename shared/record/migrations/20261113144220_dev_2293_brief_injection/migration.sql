CREATE TABLE "brief_injection" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"bytes" integer NOT NULL,
	"lines" integer NOT NULL,
	"cursors" integer NOT NULL,
	"keyless_cursors" integer NOT NULL,
	"keyless_idle_max_ms" bigint,
	"over_cap" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "brief_injection_source_check" CHECK ("source" IN ('startup','resume','clear','compact')),
	CONSTRAINT "brief_injection_bytes_check" CHECK ("bytes" >= 0),
	CONSTRAINT "brief_injection_lines_check" CHECK ("lines" >= 0),
	CONSTRAINT "brief_injection_cursors_check" CHECK ("cursors" >= 0),
	CONSTRAINT "brief_injection_keyless_cursors_check" CHECK ("keyless_cursors" >= 0 AND "keyless_cursors" <= "cursors"),
	CONSTRAINT "brief_injection_keyless_idle_max_ms_check" CHECK ("keyless_idle_max_ms" IS NULL OR "keyless_idle_max_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "brief_injection" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "brief_injection_session_at_idx" ON "brief_injection" ("session_id","at");--> statement-breakpoint
ALTER TABLE "brief_injection" ADD CONSTRAINT "brief_injection_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "brief_injection" ADD CONSTRAINT "brief_injection_machine_id_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machine"("id");--> statement-breakpoint
CREATE POLICY "brief_injection_space_select" ON "brief_injection" AS PERMISSIVE FOR SELECT TO public USING ("brief_injection"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "brief_injection"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "brief_injection_space_insert" ON "brief_injection" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("brief_injection"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "brief_injection"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "brief_injection_space_update" ON "brief_injection" AS PERMISSIVE FOR UPDATE TO public USING (("brief_injection"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "brief_injection"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("brief_injection"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "brief_injection"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "brief_injection_space_delete" ON "brief_injection" AS PERMISSIVE FOR DELETE TO public USING (("brief_injection"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "brief_injection"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));
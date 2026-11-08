CREATE TABLE "credential_payer_preference" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"provider" text NOT NULL,
	"name" text,
	"type" text NOT NULL,
	"mode" text DEFAULT 'default' NOT NULL,
	"environment" text DEFAULT 'local' NOT NULL,
	"preferred_payer" text NOT NULL,
	"preferred_binding" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "credential_payer_preference_identity_unique" UNIQUE NULLS NOT DISTINCT("space_id","user_id","project_id","provider","name","type","mode","environment"),
	CONSTRAINT "credential_payer_preference_slug_check" CHECK ("provider" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND ("name" IS NULL OR "name" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$') AND "type" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
	CONSTRAINT "credential_payer_preference_values_check" CHECK ("mode" IN ('live','test','default') AND "environment" IN ('local') AND "preferred_payer" IN ('personal','shared') AND "preferred_binding" IN ('project','space'))
);
--> statement-breakpoint
ALTER TABLE "credential_payer_preference" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "config_secret" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "config_secret" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "config_secret" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "config_secret" ADD COLUMN "type" text;--> statement-breakpoint
ALTER TABLE "config_secret" ADD COLUMN "mode" text;--> statement-breakpoint
ALTER TABLE "config_secret" ADD COLUMN "hint" text;--> statement-breakpoint
ALTER TABLE "config_secret" DROP CONSTRAINT "config_secret_scope_unique";--> statement-breakpoint
ALTER TABLE "config_secret" ADD CONSTRAINT "config_secret_scope_unique" UNIQUE NULLS NOT DISTINCT("space_id","user_id","project_id","key","environment");--> statement-breakpoint
ALTER TABLE "config_secret" ADD CONSTRAINT "config_secret_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
ALTER TABLE "credential_payer_preference" ADD CONSTRAINT "credential_payer_preference_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "credential_payer_preference" ADD CONSTRAINT "credential_payer_preference_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id");--> statement-breakpoint
ALTER TABLE "credential_payer_preference" ADD CONSTRAINT "credential_payer_preference_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
ALTER TABLE "config_secret" ADD CONSTRAINT "config_secret_credential_fields_check" CHECK (("provider" IS NULL AND "name" IS NULL AND "type" IS NULL AND "hint" IS NULL AND "project_id" IS NULL AND "mode" IS NULL) OR
          ("provider" IS NOT NULL AND ("name" IS NULL OR "name" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$') AND "type" IS NOT NULL AND "provider" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND "type" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND "hint" IS NOT NULL AND "mode" IN ('live','test','default') AND "environment" IN ('local')));--> statement-breakpoint
CREATE POLICY "credential_payer_preference_actor_select" ON "credential_payer_preference" AS PERMISSIVE FOR SELECT TO "record_actor" USING (("credential_payer_preference"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND ("credential_payer_preference"."user_id" IS NULL OR "credential_payer_preference"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "credential_payer_preference_actor_insert" ON "credential_payer_preference" AS PERMISSIVE FOR INSERT TO "record_actor" WITH CHECK (("credential_payer_preference"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND ("credential_payer_preference"."user_id" IS NULL OR "credential_payer_preference"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "credential_payer_preference"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "credential_payer_preference_actor_update" ON "credential_payer_preference" AS PERMISSIVE FOR UPDATE TO "record_actor" USING (("credential_payer_preference"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND ("credential_payer_preference"."user_id" IS NULL OR "credential_payer_preference"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "credential_payer_preference"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("credential_payer_preference"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND ("credential_payer_preference"."user_id" IS NULL OR "credential_payer_preference"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "credential_payer_preference"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "credential_payer_preference_actor_delete" ON "credential_payer_preference" AS PERMISSIVE FOR DELETE TO "record_actor" USING (("credential_payer_preference"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND ("credential_payer_preference"."user_id" IS NULL OR "credential_payer_preference"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "credential_payer_preference"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "credential_payer_preference_reader_backstop" ON "credential_payer_preference" AS RESTRICTIVE FOR SELECT TO "record_reader" USING (false);--> statement-breakpoint
CREATE POLICY "credential_payer_preference_owner_select" ON "credential_payer_preference" AS PERMISSIVE FOR SELECT TO "record_owner" USING (true);
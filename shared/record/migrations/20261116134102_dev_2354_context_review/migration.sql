CREATE TABLE "context_review" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"interval_ms" bigint NOT NULL,
	"items" integer NOT NULL,
	"flagged" integer NOT NULL,
	"item_ids" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "context_review_interval_ms_check" CHECK ("interval_ms" >= 0),
	CONSTRAINT "context_review_items_check" CHECK ("items" >= 0),
	CONSTRAINT "context_review_flagged_check" CHECK ("flagged" >= 0 AND "flagged" <= "items")
);
--> statement-breakpoint
ALTER TABLE "context_review" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "context_review_session_at_idx" ON "context_review" ("session_id","at");--> statement-breakpoint
ALTER TABLE "context_review" ADD CONSTRAINT "context_review_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "context_review" ADD CONSTRAINT "context_review_machine_id_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machine"("id");--> statement-breakpoint
CREATE POLICY "context_review_space_select" ON "context_review" AS PERMISSIVE FOR SELECT TO public USING ("context_review"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "context_review"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "context_review_space_insert" ON "context_review" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("context_review"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "context_review"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "context_review_space_update" ON "context_review" AS PERMISSIVE FOR UPDATE TO public USING (("context_review"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "context_review"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("context_review"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "context_review"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "context_review_space_delete" ON "context_review" AS PERMISSIVE FOR DELETE TO public USING (("context_review"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "context_review"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));
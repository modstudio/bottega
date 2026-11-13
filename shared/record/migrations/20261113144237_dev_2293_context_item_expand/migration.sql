CREATE TABLE "context_item" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"holder_kind" text NOT NULL,
	"holder_id" text NOT NULL,
	"slug" text NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"source" text NOT NULL,
	"question_number" integer,
	"target" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "context_item_holder_slug_unique" UNIQUE("space_id","holder_kind","holder_id","slug"),
	CONSTRAINT "context_item_holder_kind_check" CHECK ("holder_kind" IN ('task','session','cursor')),
	CONSTRAINT "context_item_kind_check" CHECK ("kind" IN ('ruling','position','fact','pointer','next-action','open-question'))
);
--> statement-breakpoint
ALTER TABLE "context_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "context_item" ADD CONSTRAINT "context_item_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
CREATE POLICY "context_item_space_select" ON "context_item" AS PERMISSIVE FOR SELECT TO public USING ("context_item"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "context_item"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "context_item_space_insert" ON "context_item" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("context_item"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "context_item"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "context_item_space_update" ON "context_item" AS PERMISSIVE FOR UPDATE TO public USING (("context_item"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "context_item"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("context_item"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "context_item"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "context_item_space_delete" ON "context_item" AS PERMISSIVE FOR DELETE TO public USING (("context_item"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "context_item"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));
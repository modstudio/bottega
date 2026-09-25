CREATE TABLE "operator_waiting_email" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"item_id" bigint NOT NULL,
	"episode" text NOT NULL,
	"project" text NOT NULL,
	"task_key" text,
	"question" text NOT NULL,
	"options" jsonb NOT NULL,
	"recommendation" text,
	"why" text,
	"waiting_since" timestamp with time zone NOT NULL,
	"link" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "operator_waiting_email_episode_unique" UNIQUE("space_id","user_id","kind","item_id","episode"),
	CONSTRAINT "operator_waiting_email_kind_check" CHECK ("kind" IN ('question','workflow')),
	CONSTRAINT "operator_waiting_email_status_check" CHECK ("status" IN ('intent','sent','failed'))
);
--> statement-breakpoint
ALTER TABLE "operator_waiting_email" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "operator_waiting_email" ADD CONSTRAINT "operator_waiting_email_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "operator_waiting_email" ADD CONSTRAINT "operator_waiting_email_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id");--> statement-breakpoint
CREATE POLICY "operator_waiting_email_space_select" ON "operator_waiting_email" AS PERMISSIVE FOR SELECT TO public USING ("operator_waiting_email"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "operator_waiting_email"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "operator_waiting_email_space_insert" ON "operator_waiting_email" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("operator_waiting_email"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "operator_waiting_email_space_update" ON "operator_waiting_email" AS PERMISSIVE FOR UPDATE TO public USING ("operator_waiting_email"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("operator_waiting_email"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "operator_waiting_email_space_delete" ON "operator_waiting_email" AS PERMISSIVE FOR DELETE TO public USING ("operator_waiting_email"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);
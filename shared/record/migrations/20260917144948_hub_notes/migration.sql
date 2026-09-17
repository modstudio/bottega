CREATE TABLE "hub_note" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"project_name" text NOT NULL,
	"number" bigint NOT NULL,
	"project" text NOT NULL,
	"text" text NOT NULL,
	"area" text,
	"anchors" text NOT NULL,
	"sightings" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"stale_at" timestamp with time zone,
	"stale_reason" text,
	"promoted_task" text,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "hub_note_space_number_unique" UNIQUE("space_id","number")
);
--> statement-breakpoint
ALTER TABLE "hub_note" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hub_note_acknowledgement" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"project_name" text NOT NULL,
	"note_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"acknowledged_at" timestamp with time zone NOT NULL,
	"sightings" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "hub_note_ack_space_session_unique" UNIQUE("space_id","note_id","session_id")
);
--> statement-breakpoint
ALTER TABLE "hub_note_acknowledgement" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hub_note" ADD CONSTRAINT "hub_note_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "hub_note_acknowledgement" ADD CONSTRAINT "hub_note_acknowledgement_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
CREATE POLICY "hub_note_space_select" ON "hub_note" AS PERMISSIVE FOR SELECT TO public USING ("hub_note"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_note_space_insert" ON "hub_note" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("hub_note"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_note_space_update" ON "hub_note" AS PERMISSIVE FOR UPDATE TO public USING ("hub_note"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("hub_note"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_note_space_delete" ON "hub_note" AS PERMISSIVE FOR DELETE TO public USING ("hub_note"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_note_acknowledgement_space_select" ON "hub_note_acknowledgement" AS PERMISSIVE FOR SELECT TO public USING ("hub_note_acknowledgement"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_note_acknowledgement_space_insert" ON "hub_note_acknowledgement" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("hub_note_acknowledgement"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_note_acknowledgement_space_update" ON "hub_note_acknowledgement" AS PERMISSIVE FOR UPDATE TO public USING ("hub_note_acknowledgement"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("hub_note_acknowledgement"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_note_acknowledgement_space_delete" ON "hub_note_acknowledgement" AS PERMISSIVE FOR DELETE TO public USING ("hub_note_acknowledgement"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);
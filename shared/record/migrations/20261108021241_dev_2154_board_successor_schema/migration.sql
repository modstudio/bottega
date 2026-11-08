CREATE TABLE "board_presence" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"session" text NOT NULL,
	"project_id" uuid NOT NULL,
	"role" text NOT NULL,
	"machine_id" uuid,
	"first_seen" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL,
	CONSTRAINT "board_presence_space_session_unique" UNIQUE("space_id","session"),
	CONSTRAINT "board_presence_role_check" CHECK ("role" = 'architect')
);
--> statement-breakpoint
ALTER TABLE "board_presence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "board_receipt" ADD COLUMN "successor" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "board_presence_last_seen_idx" ON "board_presence" ("last_seen");--> statement-breakpoint
CREATE UNIQUE INDEX "board_receipt_message_successor_unique" ON "board_receipt" ("message_id") WHERE "successor";--> statement-breakpoint
ALTER TABLE "board_presence" ADD CONSTRAINT "board_presence_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "board_presence" ADD CONSTRAINT "board_presence_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id");--> statement-breakpoint
ALTER TABLE "board_presence" ADD CONSTRAINT "board_presence_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
ALTER TABLE "board_presence" ADD CONSTRAINT "board_presence_machine_id_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machine"("id");--> statement-breakpoint
CREATE POLICY "board_presence_space_select" ON "board_presence" AS PERMISSIVE FOR SELECT TO public USING ("board_presence"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "board_presence"."space_id" = ANY(
          string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
        ));--> statement-breakpoint
CREATE POLICY "board_presence_space_insert" ON "board_presence" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("board_presence"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid AND "board_presence"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) AND (EXISTS (
      SELECT 1 FROM "membership" m
      WHERE m.space_id = "board_presence"."space_id" AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
    )));--> statement-breakpoint
CREATE POLICY "board_presence_space_update" ON "board_presence" AS PERMISSIVE FOR UPDATE TO public USING (("board_presence"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid AND "board_presence"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) AND (EXISTS (
      SELECT 1 FROM "membership" m
      WHERE m.space_id = "board_presence"."space_id" AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
    ))) WITH CHECK (("board_presence"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid AND "board_presence"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) AND (EXISTS (
      SELECT 1 FROM "membership" m
      WHERE m.space_id = "board_presence"."space_id" AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
    )));--> statement-breakpoint
CREATE POLICY "board_presence_owner_all" ON "board_presence" AS PERMISSIVE FOR ALL TO "record_owner" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "board_receipt_owner_insert" ON "board_receipt" AS PERMISSIVE FOR INSERT TO "record_owner" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "board_receipt_owner_update" ON "board_receipt" AS PERMISSIVE FOR UPDATE TO "record_owner" USING (true) WITH CHECK (true);
ALTER TABLE "hub_note" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hub_note" ADD COLUMN "hidden_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "hub_note" ADD COLUMN "hidden_reason" text;--> statement-breakpoint
ALTER TABLE "board_message" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "board_message" ADD COLUMN "hidden_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "board_message" ADD COLUMN "hidden_reason" text;--> statement-breakpoint
ALTER TABLE "hub_note" ADD CONSTRAINT "hub_note_hidden_by_user_id_user_id_fkey" FOREIGN KEY ("hidden_by_user_id") REFERENCES "user"("id");--> statement-breakpoint
ALTER TABLE "board_message" ADD CONSTRAINT "board_message_hidden_by_user_id_user_id_fkey" FOREIGN KEY ("hidden_by_user_id") REFERENCES "user"("id");--> statement-breakpoint
ALTER TABLE "hub_note" ADD CONSTRAINT "hub_note_hidden_shape_check" CHECK (("hidden_at" IS NULL AND "hidden_by_user_id" IS NULL AND "hidden_reason" IS NULL) OR
        ("hidden_at" IS NOT NULL AND "hidden_by_user_id" IS NOT NULL AND "hidden_reason" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "hub_note" ADD CONSTRAINT "hub_note_hidden_reason_check" CHECK ("hidden_reason" IS NULL OR "hidden_reason" IN ('spam', 'abuse', 'off-topic', 'personal-data', 'duplicate'));--> statement-breakpoint
ALTER TABLE "board_message" ADD CONSTRAINT "board_message_hidden_shape_check" CHECK (("hidden_at" IS NULL AND "hidden_by_user_id" IS NULL AND "hidden_reason" IS NULL) OR
          ("hidden_at" IS NOT NULL AND "hidden_by_user_id" IS NOT NULL AND "hidden_reason" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "board_message" ADD CONSTRAINT "board_message_hidden_reason_check" CHECK ("hidden_reason" IS NULL OR "hidden_reason" IN ('spam', 'abuse', 'off-topic', 'personal-data', 'duplicate'));--> statement-breakpoint
CREATE POLICY "hub_note_hidden_select" ON "hub_note" AS RESTRICTIVE FOR SELECT TO "record_actor" USING ("hub_note"."hidden_at" IS NULL OR
        "hub_note"."author_user_id" = nullif(current_setting('app.user_id', true), '')::uuid OR EXISTS (
          SELECT 1 FROM "membership" m
          WHERE m.space_id = "hub_note"."space_id"
            AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
            AND m.role = 'owner'
        ));--> statement-breakpoint
CREATE POLICY "board_message_hidden_select" ON "board_message" AS RESTRICTIVE FOR SELECT TO "record_actor" USING ("board_message"."hidden_at" IS NULL OR "board_message"."author_user_id" = nullif(current_setting('app.user_id', true), '')::uuid OR EXISTS (
      SELECT 1 FROM unnest("board_message"."scope_project_ids") scoped(project_id)
      JOIN "project" p ON p.id = scoped.project_id
      JOIN "membership" m ON m.space_id = p.space_id
      WHERE m.user_id = nullif(current_setting('app.user_id', true), '')::uuid AND m.role = 'owner'
    ));
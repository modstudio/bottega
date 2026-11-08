CREATE POLICY "board_claim_owner_delete" ON "board_claim" AS PERMISSIVE FOR DELETE TO "record_actor" USING (EXISTS (
          SELECT 1 FROM "project" p
          JOIN "membership" m ON m.space_id = p.space_id
          WHERE p.id = "board_claim"."project_id" AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid AND m.role = 'owner'
        ));--> statement-breakpoint
CREATE POLICY "board_message_run_owner_delete" ON "board_message" AS PERMISSIVE FOR DELETE TO "record_actor" USING ("board_message"."author_run_id" IS NOT NULL AND EXISTS (
          SELECT 1 FROM "run" r
          JOIN "membership" m ON m.space_id = r.space_id
          WHERE r.id = "board_message"."author_run_id" AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid AND m.role = 'owner'
        ));
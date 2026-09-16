ALTER TABLE "space" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER POLICY "membership_space_select" ON "membership" TO public USING ("membership"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "membership"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "space_space_select" ON "space" TO public USING ("space"."id" = nullif(current_setting('app.space_id', true), '')::uuid OR EXISTS (
          SELECT 1 FROM membership m WHERE m.space_id = "space"."id" AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        ));
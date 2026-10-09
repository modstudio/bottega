ALTER TABLE "doc" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "doc_revision" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "doc" SET "audiences" = ARRAY["audience"] WHERE "audiences" IS NULL;--> statement-breakpoint
UPDATE "doc_revision" SET "audiences" = ARRAY["audience"] WHERE "audiences" IS NULL;--> statement-breakpoint
ALTER POLICY "doc_public_select" ON "doc" TO "record_public" USING ('user' = ANY("doc"."audiences")
        AND "doc"."status" = 'current'
        AND "doc"."owner_user_id" IS NULL
        AND "doc"."deleted_at" IS NULL
        AND EXISTS (
          SELECT 1 FROM public_doc_space public_space
          WHERE public_space.space_id = "doc"."space_id"
            AND public_space.project_id = "doc"."project_id"
        ));--> statement-breakpoint
ALTER TABLE "doc" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "doc_revision" FORCE ROW LEVEL SECURITY;

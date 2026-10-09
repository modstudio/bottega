ALTER TABLE "doc" DROP CONSTRAINT "doc_audience_check";--> statement-breakpoint
ALTER TABLE "doc_revision" DROP CONSTRAINT "doc_revision_audience_check";--> statement-breakpoint
ALTER TABLE "doc" DROP COLUMN "audience";--> statement-breakpoint
ALTER TABLE "doc_revision" DROP COLUMN "audience";--> statement-breakpoint
ALTER TABLE "doc" ALTER COLUMN "audiences" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "doc_revision" ALTER COLUMN "audiences" SET NOT NULL;--> statement-breakpoint
ALTER POLICY "doc_public_select" ON "doc" TO "record_public" USING ('user' = ANY("doc"."audiences")
        AND "doc"."status" = 'current'
        AND "doc"."owner_user_id" IS NULL
        AND "doc"."deleted_at" IS NULL
        AND EXISTS (
          SELECT 1 FROM public_doc_space public_space
          WHERE public_space.space_id = "doc"."space_id"
            AND public_space.project_id = "doc"."project_id"
        ));
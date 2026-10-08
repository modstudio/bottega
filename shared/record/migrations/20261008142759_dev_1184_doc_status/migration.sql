ALTER TABLE "doc" ADD COLUMN "status" text DEFAULT 'current' NOT NULL;--> statement-breakpoint
ALTER TABLE "doc" ADD COLUMN "replacement_slug" text;--> statement-breakpoint
ALTER TABLE "doc_revision" ADD COLUMN "status" text DEFAULT 'current' NOT NULL;--> statement-breakpoint
ALTER TABLE "doc_revision" ADD COLUMN "replacement_slug" text;--> statement-breakpoint
ALTER TABLE "doc" ADD CONSTRAINT "doc_status_check" CHECK ("status" IN ('draft','current','superseded','archived'));--> statement-breakpoint
ALTER TABLE "doc" ADD CONSTRAINT "doc_replacement_check" CHECK (("status" = 'superseded' AND "replacement_slug" IS NOT NULL) OR ("status" <> 'superseded' AND "replacement_slug" IS NULL));--> statement-breakpoint
ALTER TABLE "doc_revision" ADD CONSTRAINT "doc_revision_status_check" CHECK ("status" IN ('draft','current','superseded','archived'));--> statement-breakpoint
ALTER TABLE "doc_revision" ADD CONSTRAINT "doc_revision_replacement_check" CHECK (("status" = 'superseded' AND "replacement_slug" IS NOT NULL) OR ("status" <> 'superseded' AND "replacement_slug" IS NULL));--> statement-breakpoint
ALTER POLICY "doc_public_select" ON "doc" TO "record_public" USING ("doc"."audience" = 'user'
        AND "doc"."status" = 'current'
        AND "doc"."owner_user_id" IS NULL
        AND "doc"."deleted_at" IS NULL
        AND EXISTS (
          SELECT 1 FROM public_doc_space public_space
          WHERE public_space.space_id = "doc"."space_id"
            AND public_space.project_id = "doc"."project_id"
        ));
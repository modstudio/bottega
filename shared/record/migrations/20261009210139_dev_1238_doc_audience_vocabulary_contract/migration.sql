ALTER TABLE "doc" DROP CONSTRAINT "doc_audiences_check", ADD CONSTRAINT "doc_audiences_check" CHECK (cardinality("audiences") > 0 AND "audiences" <@ ARRAY['technical','internal','customer']::text[]);--> statement-breakpoint
ALTER TABLE "doc_revision" DROP CONSTRAINT "doc_revision_audiences_check", ADD CONSTRAINT "doc_revision_audiences_check" CHECK (cardinality("audiences") > 0 AND "audiences" <@ ARRAY['technical','internal','customer']::text[]);--> statement-breakpoint
ALTER POLICY "doc_public_select" ON "doc" TO "record_public" USING ('customer' = ANY("doc"."audiences")
        AND "doc"."status" = 'current'
        AND "doc"."owner_user_id" IS NULL
        AND "doc"."deleted_at" IS NULL
        AND EXISTS (
          SELECT 1 FROM public_doc_space public_space
          WHERE public_space.space_id = "doc"."space_id"
            AND public_space.project_id = "doc"."project_id"
        ));
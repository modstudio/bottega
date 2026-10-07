DROP POLICY "doc_public_select" ON "doc";--> statement-breakpoint
CREATE POLICY "doc_public_select" ON "doc" AS PERMISSIVE FOR SELECT TO "record_public" USING (
  "doc"."audience" = 'user'
  AND "doc"."owner_user_id" IS NULL
  AND "doc"."deleted_at" IS NULL
  AND EXISTS (
    SELECT 1 FROM public_doc_space public_space
    WHERE public_space.space_id = "doc"."space_id"
      AND public_space.project_id = "doc"."project_id"
  )
);

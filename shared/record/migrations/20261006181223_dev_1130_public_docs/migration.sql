CREATE TABLE "public_doc_space" (
	"space_id" uuid PRIMARY KEY
);
--> statement-breakpoint
ALTER TABLE "doc" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce("title", '')), 'A') || setweight(to_tsvector('english', coalesce("body", '')), 'B')) STORED;--> statement-breakpoint
CREATE INDEX "doc_search_vector_idx" ON "doc" USING gin ("search_vector");--> statement-breakpoint
ALTER TABLE "public_doc_space" ADD CONSTRAINT "public_doc_space_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
CREATE POLICY "doc_public_select" ON "doc" AS PERMISSIVE FOR SELECT TO "record_public" USING ("doc"."audience" = 'user'
        AND "doc"."owner_user_id" IS NULL
        AND "doc"."deleted_at" IS NULL
        AND EXISTS (
          SELECT 1 FROM public_doc_space public_space
          WHERE public_space.space_id = "doc"."space_id"
        ));
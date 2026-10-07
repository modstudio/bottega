ALTER TABLE "public_doc_space" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "public_doc_space" DROP CONSTRAINT "public_doc_space_pkey";--> statement-breakpoint
ALTER TABLE "public_doc_space" ADD PRIMARY KEY ("space_id","project_id");--> statement-breakpoint
ALTER TABLE "public_doc_space" ADD CONSTRAINT "public_doc_space_space_id_project_id_project_space_id_id_fk" FOREIGN KEY ("space_id","project_id") REFERENCES "project"("space_id","id");--> statement-breakpoint
ALTER POLICY "doc_public_select" ON "doc" TO "record_public" USING ("doc"."audience" = 'user'
        AND "doc"."owner_user_id" IS NULL
        AND "doc"."deleted_at" IS NULL
        AND EXISTS (
          SELECT 1 FROM public_doc_space public_space
          WHERE public_space.space_id = "doc"."space_id"
            AND public_space.project_id = "doc"."project_id"
        ));
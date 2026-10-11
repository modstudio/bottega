CREATE TABLE "doc_related_subject" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"doc_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "doc_related_subject" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "doc" ADD COLUMN "form" text;--> statement-breakpoint
ALTER TABLE "doc" ADD COLUMN "article_subject_id" uuid;--> statement-breakpoint
ALTER TABLE "doc" ADD COLUMN "source_files" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "doc_revision" ADD COLUMN "form" text;--> statement-breakpoint
ALTER TABLE "doc_revision" ADD COLUMN "article_subject_id" uuid;--> statement-breakpoint
ALTER TABLE "doc_revision" ADD COLUMN "related_subject_ids" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "doc_revision" ADD COLUMN "source_files" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "doc_related_subject_pair" ON "doc_related_subject" ("space_id","doc_id","subject_id");--> statement-breakpoint
ALTER TABLE "doc" ADD CONSTRAINT "doc_article_subject_same_project_fk" FOREIGN KEY ("space_id","project_id","article_subject_id") REFERENCES "subject"("space_id","project_id","id");--> statement-breakpoint
ALTER TABLE "doc_related_subject" ADD CONSTRAINT "doc_related_subject_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "doc_related_subject" ADD CONSTRAINT "doc_related_subject_doc_id_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "doc"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "doc_related_subject" ADD CONSTRAINT "doc_related_subject_subject_id_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subject"("id");--> statement-breakpoint
ALTER TABLE "doc" ADD CONSTRAINT "doc_form_check" CHECK ("form" IS NULL OR "form" IN ('feature','how-to','rule','model','overview'));--> statement-breakpoint
ALTER TABLE "doc_revision" ADD CONSTRAINT "doc_revision_form_check" CHECK ("form" IS NULL OR "form" IN ('feature','how-to','rule','model','overview'));--> statement-breakpoint
CREATE POLICY "doc_related_subject_space_select" ON "doc_related_subject" AS PERMISSIVE FOR SELECT TO public USING ("doc_related_subject"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "doc_related_subject"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "doc_related_subject_space_insert" ON "doc_related_subject" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("doc_related_subject"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "doc_related_subject"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "doc_related_subject_space_update" ON "doc_related_subject" AS PERMISSIVE FOR UPDATE TO public USING (("doc_related_subject"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "doc_related_subject"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("doc_related_subject"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "doc_related_subject"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "doc_related_subject_space_delete" ON "doc_related_subject" AS PERMISSIVE FOR DELETE TO public USING (("doc_related_subject"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "doc_related_subject"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));
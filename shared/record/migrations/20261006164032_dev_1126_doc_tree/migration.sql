ALTER TABLE "doc" ADD COLUMN "audience" text DEFAULT 'technical' NOT NULL;--> statement-breakpoint
ALTER TABLE "doc" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "doc" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "doc_revision" ADD COLUMN "audience" text DEFAULT 'technical' NOT NULL;--> statement-breakpoint
ALTER TABLE "doc_revision" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "doc_revision" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "doc" ADD CONSTRAINT "doc_parent_id_doc_id_fk" FOREIGN KEY ("parent_id") REFERENCES "doc"("id");--> statement-breakpoint
ALTER TABLE "doc" ADD CONSTRAINT "doc_audience_check" CHECK ("audience" IN ('user','technical'));--> statement-breakpoint
ALTER TABLE "doc_revision" ADD CONSTRAINT "doc_revision_audience_check" CHECK ("audience" IN ('user','technical'));
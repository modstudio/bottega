ALTER TABLE "doc" ADD COLUMN "checked_against_commit" text;--> statement-breakpoint
ALTER TABLE "doc_revision" ADD COLUMN "checked_against_commit" text;
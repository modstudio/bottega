ALTER TABLE "doc" ADD COLUMN "featured" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "doc_revision" ADD COLUMN "featured" boolean DEFAULT false NOT NULL;

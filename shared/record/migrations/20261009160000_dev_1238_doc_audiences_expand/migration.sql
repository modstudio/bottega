ALTER TABLE "doc" ADD COLUMN "audiences" text[];--> statement-breakpoint
ALTER TABLE "doc_revision" ADD COLUMN "audiences" text[];--> statement-breakpoint
ALTER TABLE "doc" ADD CONSTRAINT "doc_audiences_check" CHECK (cardinality("audiences") > 0 AND "audiences" <@ ARRAY['user','technical']::text[]);--> statement-breakpoint
ALTER TABLE "doc_revision" ADD CONSTRAINT "doc_revision_audiences_check" CHECK (cardinality("audiences") > 0 AND "audiences" <@ ARRAY['user','technical']::text[]);
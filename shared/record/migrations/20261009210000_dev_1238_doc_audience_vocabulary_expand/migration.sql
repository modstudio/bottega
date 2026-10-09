ALTER TABLE "doc" DROP CONSTRAINT "doc_audiences_check";--> statement-breakpoint
ALTER TABLE "doc" ADD CONSTRAINT "doc_audiences_check" CHECK (cardinality("audiences") > 0 AND "audiences" <@ ARRAY['user','technical','internal','customer']::text[]);--> statement-breakpoint
ALTER TABLE "doc_revision" DROP CONSTRAINT "doc_revision_audiences_check";--> statement-breakpoint
ALTER TABLE "doc_revision" ADD CONSTRAINT "doc_revision_audiences_check" CHECK (cardinality("audiences") > 0 AND "audiences" <@ ARRAY['user','technical','internal','customer']::text[]);

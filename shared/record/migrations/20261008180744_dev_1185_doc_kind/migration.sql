ALTER TABLE "doc" ADD COLUMN "kind" text DEFAULT 'working' NOT NULL;--> statement-breakpoint
ALTER TABLE "doc_revision" ADD COLUMN "kind" text DEFAULT 'working' NOT NULL;--> statement-breakpoint
ALTER TABLE "doc" ADD CONSTRAINT "doc_kind_check" CHECK ("kind" IN ('working','article'));--> statement-breakpoint
ALTER TABLE "doc_revision" ADD CONSTRAINT "doc_revision_kind_check" CHECK ("kind" IN ('working','article'));
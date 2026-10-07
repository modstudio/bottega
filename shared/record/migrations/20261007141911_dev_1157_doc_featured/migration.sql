ALTER TABLE "doc" ADD COLUMN "featured" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "doc_revision" ADD COLUMN "featured" boolean DEFAULT false NOT NULL;--> statement-breakpoint
REVOKE ALL ON TABLE "doc" FROM "record_public";--> statement-breakpoint
GRANT SELECT (id, space_id, scope, subject, owner_user_id, slug, title, body, audience, featured, parent_id, position, updated_at, deleted_at, search_vector) ON TABLE "doc" TO "record_public";

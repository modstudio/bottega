ALTER TABLE "project_lens_profile" DROP CONSTRAINT "project_lens_profile_selected_version_check";--> statement-breakpoint
ALTER TABLE "project_lens_profile_revision" DROP CONSTRAINT "project_lens_profile_revision_selected_version_check";--> statement-breakpoint
ALTER TABLE "project_lens_profile" DROP COLUMN "selected_version";--> statement-breakpoint
ALTER TABLE "project_lens_profile_revision" DROP COLUMN "prior_selected_version";--> statement-breakpoint
ALTER TABLE "lens_profile" ALTER COLUMN "current_version_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "lens_profile_space_current_version_unique" ON "lens_profile" ("space_id","current_version_id");
ALTER TABLE "project_lens_profile" ADD COLUMN "selected_version_id" uuid;--> statement-breakpoint
ALTER TABLE "project_lens_profile_revision" ADD COLUMN "prior_selected_version_id" uuid;
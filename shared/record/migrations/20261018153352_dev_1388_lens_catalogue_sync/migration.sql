ALTER TABLE "lens" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "lens_profile" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "project_lens_profile" ADD COLUMN "selection_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_lens_profile" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "lens_space_updated_id_idx" ON "lens" ("space_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "lens_profile_space_updated_id_idx" ON "lens_profile" ("space_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "project_lens_profile_space_updated_id_idx" ON "project_lens_profile" ("space_id","updated_at","id");--> statement-breakpoint
ALTER TABLE "project_lens_profile" ADD CONSTRAINT "project_lens_profile_selection_version_check" CHECK ("selection_version" > 0);
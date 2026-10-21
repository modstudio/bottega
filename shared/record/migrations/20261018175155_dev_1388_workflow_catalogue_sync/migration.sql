ALTER TABLE "step_catalogue" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "step_catalogue_version" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_version" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "step_catalogue_space_updated_id_idx" ON "step_catalogue" ("space_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "step_catalogue_version_space_updated_id_idx" ON "step_catalogue_version" ("space_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "workflow_space_updated_id_idx" ON "workflow" ("space_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "workflow_version_space_updated_id_idx" ON "workflow_version" ("space_id","updated_at","id");
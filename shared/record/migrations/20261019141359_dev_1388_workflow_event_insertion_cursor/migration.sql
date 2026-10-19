ALTER TABLE "step_catalogue_event" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_event" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "step_catalogue_event_space_updated_id_idx" ON "step_catalogue_event" ("space_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "workflow_event_space_updated_id_idx" ON "workflow_event" ("space_id","updated_at","id");
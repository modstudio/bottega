ALTER TABLE "space_agent" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "space_agent" ADD COLUMN "disabled_reason" text;
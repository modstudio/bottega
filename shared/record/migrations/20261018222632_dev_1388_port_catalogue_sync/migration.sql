ALTER TABLE "port_baseline" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "port_baseline" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "port_doctrine" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "port_doctrine" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "port_ref" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "port_ref" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "port_ref" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "port_ref_source" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "port_ref_source" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "port_ref_source" ADD CONSTRAINT "port_ref_source_space_id_unique" UNIQUE("space_id","id");--> statement-breakpoint
CREATE INDEX "port_baseline_space_updated_id_idx" ON "port_baseline" ("space_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "port_doctrine_space_updated_id_idx" ON "port_doctrine" ("space_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "port_ref_space_updated_id_idx" ON "port_ref" ("space_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "port_ref_source_space_updated_id_idx" ON "port_ref_source" ("space_id","updated_at","id");
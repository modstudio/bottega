ALTER TABLE "run" ADD COLUMN "provisioning_kind" text;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "provisioning_ms" bigint;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "provisioning_phases" jsonb;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "provisioning_entries" bigint;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "provisioning_entries_limited" boolean;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "provisioning_host_load" jsonb;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "provisioning_outcome" text;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "provisioning_entry_roots" jsonb;

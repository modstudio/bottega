ALTER TABLE "run" ADD COLUMN "resource_cpu_ms" bigint;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "resource_peak_rss_bytes" bigint;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "resource_samples" integer;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "resource_source" text;
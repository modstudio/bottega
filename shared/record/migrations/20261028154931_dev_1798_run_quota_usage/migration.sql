ALTER TABLE "run" ADD COLUMN "quota_used_percent_start" double precision;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "quota_used_percent_end" double precision;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "quota_window_minutes" integer;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "quota_resets_at" bigint;
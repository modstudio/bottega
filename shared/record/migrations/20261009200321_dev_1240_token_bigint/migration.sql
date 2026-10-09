ALTER TABLE "hub_day" ALTER COLUMN "claude_tokens" SET DATA TYPE bigint USING "claude_tokens"::bigint;--> statement-breakpoint
ALTER TABLE "hub_day" ALTER COLUMN "cache_read" SET DATA TYPE bigint USING "cache_read"::bigint;--> statement-breakpoint
ALTER TABLE "hub_day" ALTER COLUMN "canon_tokens" SET DATA TYPE bigint USING "canon_tokens"::bigint;--> statement-breakpoint
ALTER TABLE "hub_day" ALTER COLUMN "other_tokens" SET DATA TYPE bigint USING "other_tokens"::bigint;--> statement-breakpoint
ALTER TABLE "hub_interval" ALTER COLUMN "claude_tokens" SET DATA TYPE bigint USING "claude_tokens"::bigint;--> statement-breakpoint
ALTER TABLE "hub_interval" ALTER COLUMN "vendor_tokens" SET DATA TYPE bigint USING "vendor_tokens"::bigint;
ALTER TABLE "run" ADD COLUMN "context_system_chars" integer;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "context_tool_count" integer;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "context_tool_schema_chars" integer;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "context_compactions" integer;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "context_cache_read_tokens" bigint;
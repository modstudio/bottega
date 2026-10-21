ALTER TABLE "run" ADD COLUMN "vendor_input_tokens" bigint;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "vendor_output_tokens" bigint;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "vendor_estimated_cost_usd" double precision;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "vendor_cost_source" text;
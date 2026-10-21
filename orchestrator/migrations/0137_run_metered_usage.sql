ALTER TABLE run ADD COLUMN vendor_input_tokens INTEGER;
--> statement-breakpoint
ALTER TABLE run ADD COLUMN vendor_output_tokens INTEGER;
--> statement-breakpoint
ALTER TABLE run ADD COLUMN vendor_estimated_cost_usd REAL;
--> statement-breakpoint
ALTER TABLE run ADD COLUMN vendor_cost_source TEXT;

ALTER TABLE "landing_override" ADD COLUMN "attribution" text DEFAULT 'operator' NOT NULL;--> statement-breakpoint
ALTER TABLE "landing_override" ADD COLUMN "missing_lenses" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "landing_override" ADD CONSTRAINT "landing_override_attribution_check" CHECK ("attribution" IN ('operator','architect-ceiling'));--> statement-breakpoint
ALTER TABLE "landing_override" ADD CONSTRAINT "landing_override_missing_lenses_check" CHECK (jsonb_typeof("missing_lenses") = 'array');
ALTER TABLE "question" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "typed_options" jsonb;--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "criteria" jsonb;--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "levels" jsonb;--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "answer_value" jsonb;--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "answered_by_kind" text;--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "jev_pick" jsonb;--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "jev_confidence" double precision;--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "jev_probabilities" jsonb;--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "jev_model" text;--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "jev_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "jev_error" text;--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "jev_agreed" integer;
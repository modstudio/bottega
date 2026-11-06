ALTER TABLE "question" ADD CONSTRAINT "question_typed_options_not_json_string_check" CHECK (jsonb_typeof("typed_options") <> 'string') NOT VALID;--> statement-breakpoint
ALTER TABLE "question" ADD CONSTRAINT "question_criteria_not_json_string_check" CHECK (jsonb_typeof("criteria") <> 'string') NOT VALID;--> statement-breakpoint
ALTER TABLE "question" ADD CONSTRAINT "question_levels_not_json_string_check" CHECK (jsonb_typeof("levels") <> 'string') NOT VALID;--> statement-breakpoint
ALTER TABLE "question" ADD CONSTRAINT "question_jev_probabilities_not_json_string_check" CHECK (jsonb_typeof("jev_probabilities") <> 'string') NOT VALID;--> statement-breakpoint
ALTER TABLE "question" VALIDATE CONSTRAINT "question_typed_options_not_json_string_check";--> statement-breakpoint
ALTER TABLE "question" VALIDATE CONSTRAINT "question_criteria_not_json_string_check";--> statement-breakpoint
ALTER TABLE "question" VALIDATE CONSTRAINT "question_levels_not_json_string_check";--> statement-breakpoint
ALTER TABLE "question" VALIDATE CONSTRAINT "question_jev_probabilities_not_json_string_check";

ALTER TABLE "review_funnel_decision" ADD CONSTRAINT "review_funnel_decision_facts_not_json_string_check" CHECK (jsonb_typeof("facts") <> 'string') NOT VALID;
ALTER TABLE "review_funnel_decision" ADD CONSTRAINT "review_funnel_decision_path_set_not_json_string_check" CHECK (jsonb_typeof("path_set") <> 'string') NOT VALID;
ALTER TABLE "review_funnel_decision" ADD CONSTRAINT "review_funnel_decision_verdict_not_json_string_check" CHECK (jsonb_typeof("verdict") <> 'string') NOT VALID;
ALTER TABLE "review_funnel_decision" ADD CONSTRAINT "review_funnel_decision_withheld_fields_not_json_string_check" CHECK (jsonb_typeof("withheld_fields") <> 'string') NOT VALID;
ALTER TABLE "review_funnel_decision" VALIDATE CONSTRAINT "review_funnel_decision_facts_not_json_string_check";
ALTER TABLE "review_funnel_decision" VALIDATE CONSTRAINT "review_funnel_decision_path_set_not_json_string_check";
ALTER TABLE "review_funnel_decision" VALIDATE CONSTRAINT "review_funnel_decision_verdict_not_json_string_check";
ALTER TABLE "review_funnel_decision" VALIDATE CONSTRAINT "review_funnel_decision_withheld_fields_not_json_string_check";

ALTER TABLE question NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE question
SET options = jsonb_build_array(options)
-- Any other string remains in place so question.options validation fails loudly instead of wrapping unknown content.
WHERE jsonb_typeof(options) = 'string'
  AND options #>> '{}' = '[withheld: secret-shaped content]';--> statement-breakpoint
ALTER TABLE question FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- run.outside_worktree_writes stays NOT VALID because 81 historical rows are top-level jsonb strings holding JSON text whose decoded form contains \u0000, which jsonb cannot store, so they cannot be repaired into structured values.
ALTER TABLE "branch_disposal" VALIDATE CONSTRAINT "branch_disposal_withheld_fields_not_json_string_check";--> statement-breakpoint
ALTER TABLE "contention" VALIDATE CONSTRAINT "contention_host_load_not_json_string_check";--> statement-breakpoint
ALTER TABLE "contention" VALIDATE CONSTRAINT "contention_withheld_fields_not_json_string_check";--> statement-breakpoint
ALTER TABLE "doc" VALIDATE CONSTRAINT "doc_source_files_not_json_string_check";--> statement-breakpoint
ALTER TABLE "doc_revision" VALIDATE CONSTRAINT "doc_revision_related_subject_ids_not_json_string_check";--> statement-breakpoint
ALTER TABLE "doc_revision" VALIDATE CONSTRAINT "doc_revision_source_files_not_json_string_check";--> statement-breakpoint
ALTER TABLE "landing" VALIDATE CONSTRAINT "landing_path_set_not_json_string_check";--> statement-breakpoint
ALTER TABLE "landing" VALIDATE CONSTRAINT "landing_steps_not_json_string_check";--> statement-breakpoint
ALTER TABLE "landing" VALIDATE CONSTRAINT "landing_withheld_fields_not_json_string_check";--> statement-breakpoint
ALTER TABLE "landing_override" VALIDATE CONSTRAINT "landing_override_missing_lenses_not_json_string_check";--> statement-breakpoint
ALTER TABLE "landing_override" VALIDATE CONSTRAINT "landing_override_path_set_not_json_string_check";--> statement-breakpoint
ALTER TABLE "landing_override" VALIDATE CONSTRAINT "landing_override_withheld_fields_not_json_string_check";--> statement-breakpoint
ALTER TABLE "landing_triage_snapshot" VALIDATE CONSTRAINT "landing_triage_snapshot_review_ids_not_json_string_check";--> statement-breakpoint
ALTER TABLE "operator_waiting_email" VALIDATE CONSTRAINT "operator_waiting_email_options_not_json_string_check";--> statement-breakpoint
ALTER TABLE "orch_snapshot" VALIDATE CONSTRAINT "orch_snapshot_payload_not_json_string_check";--> statement-breakpoint
ALTER TABLE "project" VALIDATE CONSTRAINT "project_agent_keys_not_json_string_check";--> statement-breakpoint
ALTER TABLE "project" VALIDATE CONSTRAINT "project_docs_not_json_string_check";--> statement-breakpoint
ALTER TABLE "project" VALIDATE CONSTRAINT "project_focused_tests_not_json_string_check";--> statement-breakpoint
ALTER TABLE "project" VALIDATE CONSTRAINT "project_mcp_reader_tools_not_json_string_check";--> statement-breakpoint
ALTER TABLE "project" VALIDATE CONSTRAINT "project_mcp_writer_tools_not_json_string_check";--> statement-breakpoint
ALTER TABLE "project" VALIDATE CONSTRAINT "project_mechanical_checks_not_json_string_check";--> statement-breakpoint
ALTER TABLE "project" VALIDATE CONSTRAINT "project_reference_not_json_string_check";--> statement-breakpoint
ALTER TABLE "project" VALIDATE CONSTRAINT "project_release_not_json_string_check";--> statement-breakpoint
ALTER TABLE "project" VALIDATE CONSTRAINT "project_review_not_json_string_check";--> statement-breakpoint
ALTER TABLE "project" VALIDATE CONSTRAINT "project_signals_not_json_string_check";--> statement-breakpoint
ALTER TABLE "project" VALIDATE CONSTRAINT "project_states_not_json_string_check";--> statement-breakpoint
ALTER TABLE "project" VALIDATE CONSTRAINT "project_test_substance_not_json_string_check";--> statement-breakpoint
ALTER TABLE "project" VALIDATE CONSTRAINT "project_tracker_not_json_string_check";--> statement-breakpoint
ALTER TABLE "project" VALIDATE CONSTRAINT "project_worktree_not_json_string_check";--> statement-breakpoint
ALTER TABLE "pull_request_ci" VALIDATE CONSTRAINT "pull_request_ci_failed_jobs_not_json_string_check";--> statement-breakpoint
ALTER TABLE "pull_request_ci" VALIDATE CONSTRAINT "pull_request_ci_withheld_fields_not_json_string_check";--> statement-breakpoint
ALTER TABLE "question" VALIDATE CONSTRAINT "question_options_not_json_string_check";--> statement-breakpoint
ALTER TABLE "question" VALIDATE CONSTRAINT "question_withheld_fields_not_json_string_check";--> statement-breakpoint
ALTER TABLE "release" VALIDATE CONSTRAINT "release_withheld_fields_not_json_string_check";--> statement-breakpoint
ALTER TABLE "review" VALIDATE CONSTRAINT "review_path_set_not_json_string_check";--> statement-breakpoint
ALTER TABLE "review" VALIDATE CONSTRAINT "review_tier_reasons_not_json_string_check";--> statement-breakpoint
ALTER TABLE "review" VALIDATE CONSTRAINT "review_withheld_fields_not_json_string_check";--> statement-breakpoint
ALTER TABLE "review_finding" VALIDATE CONSTRAINT "review_finding_withheld_fields_not_json_string_check";--> statement-breakpoint
ALTER TABLE "review_lens" VALIDATE CONSTRAINT "review_lens_commands_run_not_json_string_check";--> statement-breakpoint
ALTER TABLE "review_lens" VALIDATE CONSTRAINT "review_lens_could_not_verify_not_json_string_check";--> statement-breakpoint
ALTER TABLE "review_lens" VALIDATE CONSTRAINT "review_lens_docs_read_not_json_string_check";--> statement-breakpoint
ALTER TABLE "review_lens" VALIDATE CONSTRAINT "review_lens_files_covered_not_json_string_check";--> statement-breakpoint
ALTER TABLE "review_lens" VALIDATE CONSTRAINT "review_lens_mcp_tools_not_json_string_check";--> statement-breakpoint
ALTER TABLE "review_lens" VALIDATE CONSTRAINT "review_lens_standards_read_not_json_string_check";--> statement-breakpoint
ALTER TABLE "review_lens" VALIDATE CONSTRAINT "review_lens_substitutes_not_json_string_check";--> statement-breakpoint
ALTER TABLE "review_lens" VALIDATE CONSTRAINT "review_lens_withheld_fields_not_json_string_check";--> statement-breakpoint
ALTER TABLE "review_read" VALIDATE CONSTRAINT "review_read_path_set_not_json_string_check";--> statement-breakpoint
ALTER TABLE "review_read" VALIDATE CONSTRAINT "review_read_withheld_fields_not_json_string_check";--> statement-breakpoint
ALTER TABLE "run" VALIDATE CONSTRAINT "run_changed_paths_not_json_string_check";--> statement-breakpoint
ALTER TABLE "run" VALIDATE CONSTRAINT "run_doc_revisions_not_json_string_check";--> statement-breakpoint
ALTER TABLE "run" VALIDATE CONSTRAINT "run_host_admission_not_json_string_check";--> statement-breakpoint
ALTER TABLE "run" VALIDATE CONSTRAINT "run_host_admission_first_not_json_string_check";--> statement-breakpoint
ALTER TABLE "run" VALIDATE CONSTRAINT "run_provisioning_entry_roots_not_json_string_check";--> statement-breakpoint
ALTER TABLE "run" VALIDATE CONSTRAINT "run_provisioning_host_load_not_json_string_check";--> statement-breakpoint
ALTER TABLE "run" VALIDATE CONSTRAINT "run_provisioning_phases_not_json_string_check";--> statement-breakpoint
ALTER TABLE "run" VALIDATE CONSTRAINT "run_review_provenance_not_json_string_check";--> statement-breakpoint
ALTER TABLE "run" VALIDATE CONSTRAINT "run_withheld_fields_not_json_string_check";--> statement-breakpoint
ALTER TABLE "run_score" VALIDATE CONSTRAINT "run_score_withheld_fields_not_json_string_check";--> statement-breakpoint
ALTER TABLE "space" VALIDATE CONSTRAINT "space_metadata_not_json_string_check";--> statement-breakpoint
ALTER TABLE "test_flake" VALIDATE CONSTRAINT "test_flake_load_at_failure_not_json_string_check";--> statement-breakpoint
ALTER TABLE "test_flake" VALIDATE CONSTRAINT "test_flake_withheld_fields_not_json_string_check";

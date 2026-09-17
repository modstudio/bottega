ALTER POLICY "project_space_select" ON "project" TO public USING ("project"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "project"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
ALTER POLICY "seq_space_select" ON "seq" TO public USING ("seq"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "seq"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
ALTER POLICY "invitation_space_select" ON "invitation" TO public USING ("invitation"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "invitation"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
ALTER POLICY "run_space_select" ON "run" TO public USING ("run"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "run"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
ALTER POLICY "run_exclusion_space_select" ON "run_exclusion" TO public USING ("run_exclusion"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "run_exclusion"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
ALTER POLICY "run_score_space_select" ON "run_score" TO public USING ("run_score"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "run_score"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
ALTER POLICY "review_space_select" ON "review" TO public USING ("review"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "review"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
ALTER POLICY "review_finding_space_select" ON "review_finding" TO public USING ("review_finding"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "review_finding"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
ALTER POLICY "review_lens_space_select" ON "review_lens" TO public USING ("review_lens"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "review_lens"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
ALTER POLICY "contention_space_select" ON "contention" TO public USING ("contention"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "contention"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
ALTER POLICY "landing_space_select" ON "landing" TO public USING ("landing"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "landing"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
ALTER POLICY "landing_override_space_select" ON "landing_override" TO public USING ("landing_override"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "landing_override"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
ALTER POLICY "landing_review_carry_space_select" ON "landing_review_carry" TO public USING ("landing_review_carry"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "landing_review_carry"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
ALTER POLICY "test_flake_space_select" ON "test_flake" TO public USING ("test_flake"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "test_flake"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
ALTER POLICY "doc_space_select" ON "doc" TO public USING ("doc"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "doc"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
ALTER POLICY "doc_revision_space_select" ON "doc_revision" TO public USING ("doc_revision"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "doc_revision"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
ALTER POLICY "hub_day_space_select" ON "hub_day" TO public USING ("hub_day"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "hub_day"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
ALTER POLICY "hub_interval_space_select" ON "hub_interval" TO public USING ("hub_interval"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "hub_interval"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
ALTER POLICY "hub_note_space_select" ON "hub_note" TO public USING ("hub_note"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "hub_note"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
ALTER POLICY "hub_note_acknowledgement_space_select" ON "hub_note_acknowledgement" TO public USING ("hub_note_acknowledgement"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "hub_note_acknowledgement"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
ALTER POLICY "hub_report_setting_space_select" ON "hub_report_setting" TO public USING ("hub_report_setting"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "hub_report_setting"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
ALTER POLICY "hub_send_space_select" ON "hub_send" TO public USING ("hub_send"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid
        OR "hub_send"."space_id" = ANY(
          string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
        ));--> statement-breakpoint
ALTER POLICY "hub_task_space_select" ON "hub_task" TO public USING ("hub_task"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "hub_task"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
ALTER POLICY "hub_task_comment_space_select" ON "hub_task_comment" TO public USING ("hub_task_comment"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "hub_task_comment"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
ALTER POLICY "hub_task_document_space_select" ON "hub_task_document" TO public USING ("hub_task_document"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "hub_task_document"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
ALTER POLICY "hub_task_status_event_space_select" ON "hub_task_status_event" TO public USING ("hub_task_status_event"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "hub_task_status_event"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
ALTER POLICY "orch_snapshot_space_select" ON "orch_snapshot" TO public USING ("orch_snapshot"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "orch_snapshot"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));
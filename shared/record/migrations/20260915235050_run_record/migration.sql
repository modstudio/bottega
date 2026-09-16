CREATE TABLE "run" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"local_id" bigint NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"agent" text NOT NULL,
	"job" text NOT NULL,
	"prompt_sha" text NOT NULL,
	"spec_sha" text,
	"prompt_bytes" bigint NOT NULL,
	"prompt_head" text NOT NULL,
	"label" text,
	"lens" text,
	"latency_ms" bigint,
	"exit_code" integer,
	"output_bytes" bigint,
	"vendor_tokens" bigint,
	"vendor_cost_usd" double precision,
	"probe" boolean NOT NULL,
	"failure_kind" text,
	"status" text NOT NULL,
	"error" text,
	"retry_of" uuid,
	"parent_run_id" uuid,
	"turn" integer NOT NULL,
	"files_changed" integer,
	"changed_paths" jsonb,
	"lines_added" integer,
	"lines_removed" integer,
	"tests_ran" integer,
	"tests_passed" integer,
	"deviations" integer,
	"escalations" integer,
	"stack" text,
	"model" text,
	"evidence_excluded" text,
	"input_tree" text,
	"head_commit" text,
	"review_ref" text,
	"branch" text,
	"base_commit" text,
	"minted_branch" text,
	"docs_injected" integer,
	"doc_revisions" jsonb,
	"canon_sha" text,
	"transport" text,
	"session_id" text,
	"route_reason" text,
	"no_failover" boolean NOT NULL,
	"automatic_failover" boolean NOT NULL,
	"outside_worktree_writes" jsonb,
	"review_provenance" jsonb,
	"provenance_status" text,
	"work_preserved" boolean NOT NULL,
	"close_out_outcome" text,
	"close_out_detail" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "run_machine_local_unique" UNIQUE("machine_id","local_id")
);
--> statement-breakpoint
ALTER TABLE "run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_machine_id_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machine"("id");--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_retry_of_run_id_fkey" FOREIGN KEY ("retry_of") REFERENCES "run"("id");--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_parent_run_id_run_id_fkey" FOREIGN KEY ("parent_run_id") REFERENCES "run"("id");--> statement-breakpoint
CREATE POLICY "run_space_select" ON "run" AS PERMISSIVE FOR SELECT TO public USING ("run"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "run_space_insert" ON "run" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("run"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "run_space_update" ON "run" AS PERMISSIVE FOR UPDATE TO public USING ("run"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("run"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "run_space_delete" ON "run" AS PERMISSIVE FOR DELETE TO public USING ("run"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);
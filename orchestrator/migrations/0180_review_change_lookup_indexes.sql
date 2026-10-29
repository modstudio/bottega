CREATE INDEX run_project_head ON run(project_record_id, head_commit);
--> statement-breakpoint
CREATE INDEX run_project_branch ON run(project_record_id, branch, number);
--> statement-breakpoint
CREATE INDEX review_project_patch ON review(project_record_id, patch_id, path_set);

CREATE FUNCTION pg_temp.dev_1885_jsonb_value(value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  parsed jsonb;
BEGIN
  IF jsonb_typeof(value) <> 'string' THEN
    RETURN NULL;
  END IF;
  BEGIN
    parsed := (value #>> '{}')::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
  END;
  RETURN parsed;
END
$$;--> statement-breakpoint
ALTER TABLE run NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE run_score NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE review NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE review_lens NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE review_finding NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE review_read NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE landing NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE landing_override NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE pull_request_ci NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE contention NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE test_flake NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE branch_disposal NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE question NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE release NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE run
SET changed_paths=COALESCE(pg_temp.dev_1885_jsonb_value(changed_paths), changed_paths),
    doc_revisions=COALESCE(pg_temp.dev_1885_jsonb_value(doc_revisions), doc_revisions),
    outside_worktree_writes=COALESCE(pg_temp.dev_1885_jsonb_value(outside_worktree_writes), outside_worktree_writes),
    review_provenance=COALESCE(pg_temp.dev_1885_jsonb_value(review_provenance), review_provenance),
    provisioning_phases=COALESCE(pg_temp.dev_1885_jsonb_value(provisioning_phases), provisioning_phases),
    provisioning_host_load=COALESCE(pg_temp.dev_1885_jsonb_value(provisioning_host_load), provisioning_host_load),
    provisioning_entry_roots=COALESCE(pg_temp.dev_1885_jsonb_value(provisioning_entry_roots), provisioning_entry_roots),
    withheld_fields=COALESCE(pg_temp.dev_1885_jsonb_value(withheld_fields), withheld_fields)
WHERE pg_temp.dev_1885_jsonb_value(changed_paths) IS NOT NULL
   OR pg_temp.dev_1885_jsonb_value(doc_revisions) IS NOT NULL
   OR pg_temp.dev_1885_jsonb_value(outside_worktree_writes) IS NOT NULL
   OR pg_temp.dev_1885_jsonb_value(review_provenance) IS NOT NULL
   OR pg_temp.dev_1885_jsonb_value(provisioning_phases) IS NOT NULL
   OR pg_temp.dev_1885_jsonb_value(provisioning_host_load) IS NOT NULL
   OR pg_temp.dev_1885_jsonb_value(provisioning_entry_roots) IS NOT NULL
   OR pg_temp.dev_1885_jsonb_value(withheld_fields) IS NOT NULL;--> statement-breakpoint
UPDATE run_score
SET withheld_fields=pg_temp.dev_1885_jsonb_value(withheld_fields)
WHERE pg_temp.dev_1885_jsonb_value(withheld_fields) IS NOT NULL;--> statement-breakpoint
UPDATE review
SET tier_reasons=COALESCE(pg_temp.dev_1885_jsonb_value(tier_reasons), tier_reasons),
    path_set=COALESCE(pg_temp.dev_1885_jsonb_value(path_set), path_set),
    withheld_fields=COALESCE(pg_temp.dev_1885_jsonb_value(withheld_fields), withheld_fields)
WHERE pg_temp.dev_1885_jsonb_value(tier_reasons) IS NOT NULL
   OR pg_temp.dev_1885_jsonb_value(path_set) IS NOT NULL
   OR pg_temp.dev_1885_jsonb_value(withheld_fields) IS NOT NULL;--> statement-breakpoint
UPDATE review_lens
SET standards_read=COALESCE(pg_temp.dev_1885_jsonb_value(standards_read), standards_read),
    files_covered=COALESCE(pg_temp.dev_1885_jsonb_value(files_covered), files_covered),
    commands_run=COALESCE(pg_temp.dev_1885_jsonb_value(commands_run), commands_run),
    could_not_verify=COALESCE(pg_temp.dev_1885_jsonb_value(could_not_verify), could_not_verify),
    mcp_tools=COALESCE(pg_temp.dev_1885_jsonb_value(mcp_tools), mcp_tools),
    docs_read=COALESCE(pg_temp.dev_1885_jsonb_value(docs_read), docs_read),
    substitutes=COALESCE(pg_temp.dev_1885_jsonb_value(substitutes), substitutes),
    withheld_fields=COALESCE(pg_temp.dev_1885_jsonb_value(withheld_fields), withheld_fields)
WHERE pg_temp.dev_1885_jsonb_value(standards_read) IS NOT NULL
   OR pg_temp.dev_1885_jsonb_value(files_covered) IS NOT NULL
   OR pg_temp.dev_1885_jsonb_value(commands_run) IS NOT NULL
   OR pg_temp.dev_1885_jsonb_value(could_not_verify) IS NOT NULL
   OR pg_temp.dev_1885_jsonb_value(mcp_tools) IS NOT NULL
   OR pg_temp.dev_1885_jsonb_value(docs_read) IS NOT NULL
   OR pg_temp.dev_1885_jsonb_value(substitutes) IS NOT NULL
   OR pg_temp.dev_1885_jsonb_value(withheld_fields) IS NOT NULL;--> statement-breakpoint
UPDATE review_finding
SET withheld_fields=pg_temp.dev_1885_jsonb_value(withheld_fields)
WHERE pg_temp.dev_1885_jsonb_value(withheld_fields) IS NOT NULL;--> statement-breakpoint
UPDATE review_read
SET path_set=COALESCE(pg_temp.dev_1885_jsonb_value(path_set), path_set),
    withheld_fields=COALESCE(pg_temp.dev_1885_jsonb_value(withheld_fields), withheld_fields)
WHERE pg_temp.dev_1885_jsonb_value(path_set) IS NOT NULL
   OR pg_temp.dev_1885_jsonb_value(withheld_fields) IS NOT NULL;--> statement-breakpoint
UPDATE landing
SET path_set=COALESCE(pg_temp.dev_1885_jsonb_value(path_set), path_set),
    steps=COALESCE(pg_temp.dev_1885_jsonb_value(steps), steps),
    withheld_fields=COALESCE(pg_temp.dev_1885_jsonb_value(withheld_fields), withheld_fields)
WHERE pg_temp.dev_1885_jsonb_value(path_set) IS NOT NULL
   OR pg_temp.dev_1885_jsonb_value(steps) IS NOT NULL
   OR pg_temp.dev_1885_jsonb_value(withheld_fields) IS NOT NULL;--> statement-breakpoint
UPDATE landing_override
SET path_set=COALESCE(pg_temp.dev_1885_jsonb_value(path_set), path_set),
    missing_lenses=COALESCE(pg_temp.dev_1885_jsonb_value(missing_lenses), missing_lenses),
    withheld_fields=COALESCE(pg_temp.dev_1885_jsonb_value(withheld_fields), withheld_fields)
WHERE pg_temp.dev_1885_jsonb_value(path_set) IS NOT NULL
   OR pg_temp.dev_1885_jsonb_value(missing_lenses) IS NOT NULL
   OR pg_temp.dev_1885_jsonb_value(withheld_fields) IS NOT NULL;--> statement-breakpoint
UPDATE pull_request_ci
SET failed_jobs=COALESCE(pg_temp.dev_1885_jsonb_value(failed_jobs), failed_jobs),
    withheld_fields=COALESCE(pg_temp.dev_1885_jsonb_value(withheld_fields), withheld_fields)
WHERE pg_temp.dev_1885_jsonb_value(failed_jobs) IS NOT NULL
   OR pg_temp.dev_1885_jsonb_value(withheld_fields) IS NOT NULL;--> statement-breakpoint
UPDATE contention
SET withheld_fields=pg_temp.dev_1885_jsonb_value(withheld_fields)
WHERE pg_temp.dev_1885_jsonb_value(withheld_fields) IS NOT NULL;--> statement-breakpoint
UPDATE test_flake
SET load_at_failure=COALESCE(pg_temp.dev_1885_jsonb_value(load_at_failure), load_at_failure),
    withheld_fields=COALESCE(pg_temp.dev_1885_jsonb_value(withheld_fields), withheld_fields)
WHERE pg_temp.dev_1885_jsonb_value(load_at_failure) IS NOT NULL
   OR pg_temp.dev_1885_jsonb_value(withheld_fields) IS NOT NULL;--> statement-breakpoint
UPDATE branch_disposal
SET withheld_fields=pg_temp.dev_1885_jsonb_value(withheld_fields)
WHERE pg_temp.dev_1885_jsonb_value(withheld_fields) IS NOT NULL;--> statement-breakpoint
UPDATE question
SET options=COALESCE(pg_temp.dev_1885_jsonb_value(options), options),
    withheld_fields=COALESCE(pg_temp.dev_1885_jsonb_value(withheld_fields), withheld_fields)
WHERE pg_temp.dev_1885_jsonb_value(options) IS NOT NULL
   OR pg_temp.dev_1885_jsonb_value(withheld_fields) IS NOT NULL;--> statement-breakpoint
UPDATE release
SET withheld_fields=pg_temp.dev_1885_jsonb_value(withheld_fields)
WHERE pg_temp.dev_1885_jsonb_value(withheld_fields) IS NOT NULL;--> statement-breakpoint
ALTER TABLE run FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE run_score FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE review FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE review_lens FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE review_finding FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE review_read FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE landing FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE landing_override FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE pull_request_ci FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE contention FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE test_flake FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE branch_disposal FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE question FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE release FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP FUNCTION pg_temp.dev_1885_jsonb_value(jsonb);

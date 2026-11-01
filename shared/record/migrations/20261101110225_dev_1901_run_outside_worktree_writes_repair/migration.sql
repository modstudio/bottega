ALTER TABLE "run" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE
  rewritten_count bigint;
  decoded_count bigint;
BEGIN
  SELECT
    count(*) FILTER (WHERE ("outside_worktree_writes" #>> '{}') LIKE '%' || E'\\u0000' || '%'),
    count(*)
  INTO rewritten_count, decoded_count
  FROM "run"
  WHERE jsonb_typeof("outside_worktree_writes") = 'string';

  UPDATE "run"
  SET "outside_worktree_writes" = replace(
    "outside_worktree_writes" #>> '{}',
    E'\\u0000',
    E'\\n'
  )::jsonb
  WHERE jsonb_typeof("outside_worktree_writes") = 'string';

  RAISE NOTICE 'run.outside_worktree_writes rewrote % rows containing the \\u0000 escape', rewritten_count;
  RAISE NOTICE 'run.outside_worktree_writes decoded % top-level string rows', decoded_count;
END
$$;--> statement-breakpoint
ALTER TABLE "run" VALIDATE CONSTRAINT "run_outside_worktree_writes_not_json_string_check";--> statement-breakpoint
ALTER TABLE "run" FORCE ROW LEVEL SECURITY;

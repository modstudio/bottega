ALTER TABLE "run" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "run"
SET "outside_worktree_writes" = replace(
  "outside_worktree_writes" #>> '{}',
  E'\\u0000',
  E'\\n'
)::jsonb
WHERE jsonb_typeof("outside_worktree_writes") = 'string';--> statement-breakpoint
ALTER TABLE "run" VALIDATE CONSTRAINT "run_outside_worktree_writes_not_json_string_check";--> statement-breakpoint
ALTER TABLE "run" FORCE ROW LEVEL SECURITY;

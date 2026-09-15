ALTER TABLE "project" RENAME COLUMN "worktree_recipe" TO "worktree";--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "worker_mcp_servers" text[];--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "secret_paths" text[];
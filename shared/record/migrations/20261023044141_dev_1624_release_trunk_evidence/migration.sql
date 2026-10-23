ALTER TABLE "release" ADD COLUMN "trunk" text;--> statement-breakpoint
ALTER TABLE "release" ADD COLUMN "trunk_tip" text;--> statement-breakpoint
ALTER TABLE "release" ADD COLUMN "commits_behind_trunk" integer;--> statement-breakpoint
ALTER TABLE "release" ADD COLUMN "behind_trunk_reason" text;
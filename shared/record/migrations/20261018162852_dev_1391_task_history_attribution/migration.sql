ALTER TABLE "hub_task_comment" ADD COLUMN "actor_user_id" text;--> statement-breakpoint
ALTER TABLE "hub_task_comment" ADD COLUMN "actor_name" text;--> statement-breakpoint
ALTER TABLE "hub_task_comment" ADD COLUMN "agent" text;--> statement-breakpoint
ALTER TABLE "hub_task_comment" ADD COLUMN "run_id" text;--> statement-breakpoint
ALTER TABLE "hub_task_status_event" ADD COLUMN "actor_user_id" text;--> statement-breakpoint
ALTER TABLE "hub_task_status_event" ADD COLUMN "actor_name" text;--> statement-breakpoint
ALTER TABLE "hub_task_status_event" ADD COLUMN "agent" text;--> statement-breakpoint
ALTER TABLE "hub_task_status_event" ADD COLUMN "run_id" text;
ALTER TABLE "hub_send" DROP CONSTRAINT "hub_send_space_legacy_unique";--> statement-breakpoint
ALTER TABLE "hub_task_comment" DROP CONSTRAINT "hub_task_comment_legacy_unique";--> statement-breakpoint
ALTER TABLE "hub_task_document" DROP CONSTRAINT "hub_task_document_legacy_unique";--> statement-breakpoint
ALTER TABLE "hub_task_status_event" DROP CONSTRAINT "hub_task_status_event_legacy_unique";--> statement-breakpoint
ALTER TABLE "hub_send" DROP COLUMN "legacy_local_id";--> statement-breakpoint
ALTER TABLE "hub_task_comment" DROP COLUMN "legacy_local_id";--> statement-breakpoint
ALTER TABLE "hub_task_document" DROP COLUMN "legacy_local_id";--> statement-breakpoint
ALTER TABLE "hub_task_status_event" DROP COLUMN "legacy_local_id";
ALTER TABLE "hub_interval" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "hub_note" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "hub_note_acknowledgement" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "hub_report_subscription" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "hub_task" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "hub_task_comment" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "hub_task_document" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "hub_task_status_event" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "hub_interval" ADD CONSTRAINT "hub_interval_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "hub_note" ADD CONSTRAINT "hub_note_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "hub_note_acknowledgement" ADD CONSTRAINT "hub_note_acknowledgement_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "hub_report_subscription" ADD CONSTRAINT "hub_report_subscription_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "hub_task" ADD CONSTRAINT "hub_task_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "hub_task_comment" ADD CONSTRAINT "hub_task_comment_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "hub_task_document" ADD CONSTRAINT "hub_task_document_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "hub_task_status_event" ADD CONSTRAINT "hub_task_status_event_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "hub_interval" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hub_note" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hub_note_acknowledgement" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hub_report_subscription" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hub_task" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hub_task_comment" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hub_task_document" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hub_task_status_event" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE hub_task AS row SET project_id = match.id
FROM (
  SELECT space_id, name, (array_agg(id ORDER BY id))[1] AS id FROM project GROUP BY space_id, name HAVING count(*) = 1
) AS match
WHERE row.project_id IS NULL AND row.space_id = match.space_id AND row.project_name = match.name;
UPDATE hub_task_comment AS row SET project_id = match.id
FROM (
  SELECT space_id, name, (array_agg(id ORDER BY id))[1] AS id FROM project GROUP BY space_id, name HAVING count(*) = 1
) AS match
WHERE row.project_id IS NULL AND row.space_id = match.space_id AND row.project_name = match.name;
UPDATE hub_task_document AS row SET project_id = match.id
FROM (
  SELECT space_id, name, (array_agg(id ORDER BY id))[1] AS id FROM project GROUP BY space_id, name HAVING count(*) = 1
) AS match
WHERE row.project_id IS NULL AND row.space_id = match.space_id AND row.project_name = match.name;
UPDATE hub_task_status_event AS row SET project_id = match.id
FROM (
  SELECT space_id, name, (array_agg(id ORDER BY id))[1] AS id FROM project GROUP BY space_id, name HAVING count(*) = 1
) AS match
WHERE row.project_id IS NULL AND row.space_id = match.space_id AND row.project_name = match.name;
UPDATE hub_note AS row SET project_id = match.id
FROM (
  SELECT space_id, name, (array_agg(id ORDER BY id))[1] AS id FROM project GROUP BY space_id, name HAVING count(*) = 1
) AS match
WHERE row.project_id IS NULL AND row.space_id = match.space_id AND row.project_name = match.name;
UPDATE hub_note_acknowledgement AS row SET project_id = match.id
FROM (
  SELECT space_id, name, (array_agg(id ORDER BY id))[1] AS id FROM project GROUP BY space_id, name HAVING count(*) = 1
) AS match
WHERE row.project_id IS NULL AND row.space_id = match.space_id AND row.project_name = match.name;
UPDATE hub_interval AS row SET project_id = match.id
FROM (
  SELECT space_id, name, (array_agg(id ORDER BY id))[1] AS id FROM project GROUP BY space_id, name HAVING count(*) = 1
) AS match
WHERE row.project_id IS NULL AND row.space_id = match.space_id AND row.project_name = match.name;
UPDATE hub_report_subscription AS row SET project_id = match.id
FROM (
  SELECT space_id, name, (array_agg(id ORDER BY id))[1] AS id FROM project GROUP BY space_id, name HAVING count(*) = 1
) AS match
WHERE row.project_id IS NULL AND row.space_id = match.space_id AND row.project_name = match.name;
DO $$
DECLARE
  unmatched_task bigint;
  unmatched_comment bigint;
  unmatched_document bigint;
  unmatched_status_event bigint;
  unmatched_note bigint;
  unmatched_acknowledgement bigint;
  unmatched_interval bigint;
  unmatched_subscription bigint;
BEGIN
  SELECT count(*) INTO unmatched_task FROM hub_task WHERE project_name IS NOT NULL AND project_id IS NULL;
  SELECT count(*) INTO unmatched_comment FROM hub_task_comment WHERE project_name IS NOT NULL AND project_id IS NULL;
  SELECT count(*) INTO unmatched_document FROM hub_task_document WHERE project_name IS NOT NULL AND project_id IS NULL;
  SELECT count(*) INTO unmatched_status_event FROM hub_task_status_event WHERE project_name IS NOT NULL AND project_id IS NULL;
  SELECT count(*) INTO unmatched_note FROM hub_note WHERE project_name IS NOT NULL AND project_id IS NULL;
  SELECT count(*) INTO unmatched_acknowledgement FROM hub_note_acknowledgement WHERE project_name IS NOT NULL AND project_id IS NULL;
  SELECT count(*) INTO unmatched_interval FROM hub_interval WHERE project_name IS NOT NULL AND project_id IS NULL;
  SELECT count(*) INTO unmatched_subscription FROM hub_report_subscription WHERE project_name IS NOT NULL AND project_id IS NULL;
  RAISE NOTICE 'DEV-1214 unmatched hub project_id: task=%, comment=%, document=%, status_event=%, note=%, acknowledgement=%, interval=%, subscription=%',
    unmatched_task, unmatched_comment, unmatched_document, unmatched_status_event,
    unmatched_note, unmatched_acknowledgement, unmatched_interval, unmatched_subscription;
END $$;
--> statement-breakpoint
ALTER TABLE "hub_interval" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hub_note" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hub_note_acknowledgement" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hub_report_subscription" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hub_task" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hub_task_comment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hub_task_document" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hub_task_status_event" FORCE ROW LEVEL SECURITY;
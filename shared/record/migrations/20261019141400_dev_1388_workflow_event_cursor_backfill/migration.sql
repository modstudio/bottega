ALTER TABLE "step_catalogue_event" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "workflow_event" NO FORCE ROW LEVEL SECURITY;
UPDATE "step_catalogue_event" SET "updated_at" = "at";
UPDATE "workflow_event" SET "updated_at" = "at";
ALTER TABLE "step_catalogue_event" FORCE ROW LEVEL SECURITY;
ALTER TABLE "workflow_event" FORCE ROW LEVEL SECURITY;

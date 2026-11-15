ALTER TABLE "run" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "project" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE "run"
SET "stack"="project"."stack"
FROM "project"
WHERE "run"."project_id"="project"."id"
  AND ("run"."stack" IS NULL OR btrim("run"."stack")='')
  AND "project"."stack" IS NOT NULL
  AND btrim("project"."stack")<>'';
--> statement-breakpoint
ALTER TABLE "project" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "run" FORCE ROW LEVEL SECURITY;

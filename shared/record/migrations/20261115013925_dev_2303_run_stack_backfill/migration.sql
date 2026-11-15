UPDATE "run"
SET "stack"=btrim("project"."stack")
FROM "project"
WHERE "run"."project_id"="project"."id"
  AND ("run"."stack" IS NULL OR btrim("run"."stack")='')
  AND "project"."stack" IS NOT NULL
  AND btrim("project"."stack")<>'';

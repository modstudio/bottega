ALTER TABLE "doc_revision" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
WITH "sole_person" AS (
  SELECT min("id"::text) AS "id"
  FROM "user"
  WHERE "id" <> '01990000-0000-7000-8000-000000000002'
  HAVING count(*) = 1
)
UPDATE "doc_revision"
SET "author" = "sole_person"."id"
FROM "sole_person"
WHERE "doc_revision"."author" <> 'migration'
  AND "doc_revision"."at" < '2026-10-13T02:00:00Z'
  AND "doc_revision"."author" <> "sole_person"."id";--> statement-breakpoint
ALTER TABLE "doc_revision" FORCE ROW LEVEL SECURITY;

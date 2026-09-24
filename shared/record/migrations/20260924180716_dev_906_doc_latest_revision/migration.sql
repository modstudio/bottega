ALTER TABLE "doc" ADD COLUMN "latest_revision_id" uuid;--> statement-breakpoint
UPDATE "doc" AS d
SET "latest_revision_id" = latest.id
FROM (
  SELECT DISTINCT ON (space_id, doc_id) space_id, doc_id, id
  FROM "doc_revision"
  ORDER BY space_id, doc_id, at DESC, id DESC
) AS latest
WHERE d.space_id = latest.space_id AND d.id = latest.doc_id;

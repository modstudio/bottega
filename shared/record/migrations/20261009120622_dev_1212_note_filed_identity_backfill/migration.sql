ALTER TABLE "question" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE "question"
SET "filed_label" = "filed_ref", "filed_ref" = NULL
WHERE "filed_as" = 'canon-proposal' AND "filed_ref" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "question" FORCE ROW LEVEL SECURITY;

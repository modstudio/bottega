ALTER TABLE "context_item" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DELETE FROM "context_item" WHERE "kind" IN ('next-action','open-question');
--> statement-breakpoint
ALTER TABLE "context_item" FORCE ROW LEVEL SECURITY;

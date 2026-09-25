ALTER TABLE "question" ADD COLUMN "revision" integer;--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "withheld_fields" jsonb;--> statement-breakpoint
ALTER TABLE "question" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "question" SET "revision"=1,"withheld_fields"='[]'::jsonb;--> statement-breakpoint
ALTER TABLE "question" ALTER COLUMN "revision" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "question" ALTER COLUMN "withheld_fields" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "question" FORCE ROW LEVEL SECURITY;

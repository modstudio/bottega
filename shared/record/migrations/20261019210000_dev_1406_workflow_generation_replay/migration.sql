ALTER TABLE "workflow" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "step_catalogue" NO FORCE ROW LEVEL SECURITY;
UPDATE "workflow" SET "generation" = "generation" + 1, "updated_at" = now();
UPDATE "step_catalogue" SET "generation" = "generation" + 1, "updated_at" = now();
ALTER TABLE "workflow" FORCE ROW LEVEL SECURITY;
ALTER TABLE "step_catalogue" FORCE ROW LEVEL SECURITY;

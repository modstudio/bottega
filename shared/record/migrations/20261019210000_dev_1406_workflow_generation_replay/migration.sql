UPDATE "workflow" SET "generation" = "generation" + 1, "updated_at" = now();
UPDATE "step_catalogue" SET "generation" = "generation" + 1, "updated_at" = now();

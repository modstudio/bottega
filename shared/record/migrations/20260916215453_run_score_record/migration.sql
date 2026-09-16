CREATE TABLE "run_score" (
	"run_id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"delivery" text NOT NULL,
	"quality" text,
	"fidelity" text,
	"note" text,
	"scored_at" timestamp with time zone NOT NULL,
	"scored_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "run_score_delivery_check" CHECK ("delivery" IN ('none', 'partial', 'full')),
	CONSTRAINT "run_score_quality_check" CHECK ("quality" IS NULL OR "quality" IN ('wrong', 'mixed', 'right')),
	CONSTRAINT "run_score_fidelity_check" CHECK ("fidelity" IS NULL OR "fidelity" IN ('drifted', 'partial', 'faithful')),
	CONSTRAINT "run_score_delivery_quality_check" CHECK (("delivery" = 'none') = ("quality" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "run_score" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "run_score" ADD CONSTRAINT "run_score_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
CREATE POLICY "run_score_space_select" ON "run_score" AS PERMISSIVE FOR SELECT TO public USING ("run_score"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "run_score_space_insert" ON "run_score" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("run_score"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "run_score_space_update" ON "run_score" AS PERMISSIVE FOR UPDATE TO public USING ("run_score"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("run_score"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "run_score_space_delete" ON "run_score" AS PERMISSIVE FOR DELETE TO public USING ("run_score"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);
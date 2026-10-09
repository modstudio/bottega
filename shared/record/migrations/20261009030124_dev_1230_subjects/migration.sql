CREATE TABLE "subject" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"definition" text NOT NULL,
	"position" integer NOT NULL,
	"parent_id" uuid,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "subject_name_check" CHECK (length(trim("name")) > 0),
	CONSTRAINT "subject_definition_check" CHECK (length(trim("definition")) > 0 AND position(E'\n' in "definition") = 0 AND position(E'\r' in "definition") = 0),
	CONSTRAINT "subject_position_check" CHECK ("position" >= 0),
	CONSTRAINT "subject_parent_check" CHECK ("parent_id" IS NULL OR "parent_id" <> "id")
);
--> statement-breakpoint
ALTER TABLE "subject" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "subject_space_project_id_unique" ON "subject" ("space_id","project_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "subject_live_name" ON "subject" ("space_id","project_id","name") WHERE "retired_at" IS NULL;--> statement-breakpoint
CREATE INDEX "subject_project_position" ON "subject" ("space_id","project_id","position","id");--> statement-breakpoint
ALTER TABLE "subject" ADD CONSTRAINT "subject_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "subject" ADD CONSTRAINT "subject_space_project_fk" FOREIGN KEY ("space_id","project_id") REFERENCES "project"("space_id","id") ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "subject" ADD CONSTRAINT "subject_parent_same_project_fk" FOREIGN KEY ("space_id","project_id","parent_id") REFERENCES "subject"("space_id","project_id","id");--> statement-breakpoint
CREATE POLICY "subject_space_select" ON "subject" AS PERMISSIVE FOR SELECT TO public USING ("subject"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "subject"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "subject_space_insert" ON "subject" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("subject"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "subject_space_update" ON "subject" AS PERMISSIVE FOR UPDATE TO public USING ("subject"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("subject"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "subject_space_delete" ON "subject" AS PERMISSIVE FOR DELETE TO public USING ("subject"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);

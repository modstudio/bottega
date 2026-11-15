CREATE TABLE "question_number_counter" (
	"id" uuid PRIMARY KEY DEFAULT public.record_uuid_v7(),
	"space_id" uuid NOT NULL CONSTRAINT "question_number_counter_space_unique" UNIQUE,
	"next" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "question_number_counter" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "last_request_id" uuid;--> statement-breakpoint
ALTER TABLE "question_number_counter" ADD CONSTRAINT "question_number_counter_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "question_number_counter_space_select" ON "question_number_counter" AS PERMISSIVE FOR SELECT TO public USING ("question_number_counter"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "question_number_counter"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "question_number_counter_space_insert" ON "question_number_counter" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("question_number_counter"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "question_number_counter"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "question_number_counter_space_update" ON "question_number_counter" AS PERMISSIVE FOR UPDATE TO public USING (("question_number_counter"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "question_number_counter"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("question_number_counter"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "question_number_counter"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "question_number_counter_space_delete" ON "question_number_counter" AS PERMISSIVE FOR DELETE TO public USING (("question_number_counter"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "question_number_counter"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
ALTER TABLE "question_number_counter" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $migration$
DECLARE
  definition text;
  previous text := '(''question'',''project''),(''question_mutation_audit'',''parent'')';
  replacement text := '(''question'',''project''),(''question_number_counter'',''space''),(''question_mutation_audit'',''parent'')';
BEGIN
  SELECT pg_get_functiondef('record_move_project_space(text,text,text,bigint)'::regprocedure)
    INTO definition;
  IF position(previous IN definition) = 0 THEN
    RAISE EXCEPTION 'record_move_project_space question classification anchor is missing';
  END IF;
  EXECUTE replace(definition, previous, replacement);
END
$migration$;

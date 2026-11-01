CREATE TABLE "routing_evidence_head" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL CONSTRAINT "routing_evidence_head_space_unique" UNIQUE,
	"sequence" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "routing_evidence_head" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "evidence_seq" bigint;--> statement-breakpoint
CREATE INDEX "run_space_evidence_seq_idx" ON "run" ("space_id","evidence_seq");--> statement-breakpoint
ALTER TABLE "routing_evidence_head" ADD CONSTRAINT "routing_evidence_head_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
CREATE POLICY "routing_evidence_head_space_select" ON "routing_evidence_head" AS PERMISSIVE FOR SELECT TO public USING ("routing_evidence_head"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "routing_evidence_head"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "routing_evidence_head_space_insert" ON "routing_evidence_head" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("routing_evidence_head"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "routing_evidence_head"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "routing_evidence_head_space_update" ON "routing_evidence_head" AS PERMISSIVE FOR UPDATE TO public USING (("routing_evidence_head"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "routing_evidence_head"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("routing_evidence_head"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "routing_evidence_head"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "routing_evidence_head_space_delete" ON "routing_evidence_head" AS PERMISSIVE FOR DELETE TO public USING (("routing_evidence_head"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "routing_evidence_head"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));
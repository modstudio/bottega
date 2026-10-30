CREATE TABLE "machine_name_claim" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"short_name" text NOT NULL,
	"machine_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "machine_name_claim_space_short_name_unique" UNIQUE("space_id","short_name")
);
--> statement-breakpoint
ALTER TABLE "machine_name_claim" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "machine" ADD COLUMN "short_name" text;--> statement-breakpoint
ALTER TABLE "machine" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "machine" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machine_name_claim" ADD CONSTRAINT "machine_name_claim_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "machine_name_claim" ADD CONSTRAINT "machine_name_claim_machine_id_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machine"("id");--> statement-breakpoint
CREATE POLICY "machine_name_claim_space_select" ON "machine_name_claim" AS PERMISSIVE FOR SELECT TO public USING ("machine_name_claim"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "machine_name_claim"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "machine_name_claim_space_insert" ON "machine_name_claim" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("machine_name_claim"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "machine_name_claim"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));
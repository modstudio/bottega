CREATE TABLE "hub_change" (
	"space_id" uuid,
	"sequence" bigint,
	"table_name" text NOT NULL,
	"row_id" uuid NOT NULL,
	"op" text NOT NULL,
	"at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "hub_change_pkey" PRIMARY KEY("space_id","sequence"),
	CONSTRAINT "hub_change_op_check" CHECK ("op" IN ('upsert','delete'))
);
--> statement-breakpoint
ALTER TABLE "hub_change" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hub_change_head" (
	"space_id" uuid PRIMARY KEY,
	"sequence" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hub_change_head" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hub_change" ADD CONSTRAINT "hub_change_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "hub_change_head" ADD CONSTRAINT "hub_change_head_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
CREATE POLICY "hub_change_space_select" ON "hub_change" AS PERMISSIVE FOR SELECT TO public USING ("hub_change"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_change_space_insert" ON "hub_change" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("hub_change"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_change_owner_all" ON "hub_change" AS PERMISSIVE FOR ALL TO "record_owner" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "hub_change_head_space_select" ON "hub_change_head" AS PERMISSIVE FOR SELECT TO public USING ("hub_change_head"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_change_head_space_insert" ON "hub_change_head" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("hub_change_head"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_change_head_space_update" ON "hub_change_head" AS PERMISSIVE FOR UPDATE TO public USING ("hub_change_head"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("hub_change_head"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_change_head_owner_all" ON "hub_change_head" AS PERMISSIVE FOR ALL TO "record_owner" USING (true) WITH CHECK (true);
CREATE TABLE "record_change" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "record_change_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"xid" xid8 DEFAULT pg_current_xact_id() NOT NULL,
	"space_id" uuid,
	"user_id" uuid,
	"table_name" text NOT NULL,
	"row_id" uuid NOT NULL,
	"op" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "record_change_attribution_check" CHECK (num_nonnulls("space_id", "user_id") = 1),
	CONSTRAINT "record_change_op_check" CHECK ("op" IN ('upsert','delete'))
);
--> statement-breakpoint
ALTER TABLE "record_change" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "record_change_horizon" (
	"singleton" boolean PRIMARY KEY DEFAULT true,
	"seq" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "record_change_horizon_singleton_check" CHECK ("singleton")
);
--> statement-breakpoint
ALTER TABLE "record_change_horizon" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "record_change_space_seq_idx" ON "record_change" ("space_id","seq");--> statement-breakpoint
ALTER TABLE "record_change" ADD CONSTRAINT "record_change_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "record_change" ADD CONSTRAINT "record_change_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id");--> statement-breakpoint
CREATE POLICY "record_change_space_select" ON "record_change" AS PERMISSIVE FOR SELECT TO "record_actor" USING ("record_change"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "record_change_space_insert" ON "record_change" AS PERMISSIVE FOR INSERT TO "record_actor" WITH CHECK ("record_change"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "record_change_owner_all" ON "record_change" AS PERMISSIVE FOR ALL TO "record_owner" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "record_change_horizon_actor_select" ON "record_change_horizon" AS PERMISSIVE FOR SELECT TO "record_actor" USING (true);--> statement-breakpoint
CREATE POLICY "record_change_horizon_owner_all" ON "record_change_horizon" AS PERMISSIVE FOR ALL TO "record_owner" USING (true) WITH CHECK (true);
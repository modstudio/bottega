CREATE TABLE "hub_report_subscription_member" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hub_report_subscription_member_unique" UNIQUE("subscription_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "hub_report_subscription_member" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hub_send" DROP CONSTRAINT "hub_send_subscription_period_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "hub_send_subscription_period_unique" ON "hub_send" ("subscription_id","period_end") WHERE "test" = 0;--> statement-breakpoint
ALTER TABLE "hub_report_subscription_member" ADD CONSTRAINT "hub_report_subscription_member_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "hub_report_subscription_member" ADD CONSTRAINT "hub_report_subscription_member_ND9aMX9CHD2U_fkey" FOREIGN KEY ("subscription_id") REFERENCES "hub_report_subscription"("id");--> statement-breakpoint
ALTER TABLE "hub_report_subscription_member" ADD CONSTRAINT "hub_report_subscription_member_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id");--> statement-breakpoint
WITH existing_person_subscription AS (
  SELECT "id","space_id","person_user_id" FROM "hub_report_subscription" WHERE "scope_kind"='person'
), migrated_subscription_member AS (
  INSERT INTO "hub_report_subscription_member" ("id","space_id","subscription_id","user_id","created_at")
  SELECT gen_random_uuid(),"space_id","id","person_user_id",now() FROM existing_person_subscription
  RETURNING "id"
)
SELECT count(*) FROM migrated_subscription_member;--> statement-breakpoint
ALTER TABLE "hub_report_subscription" DROP CONSTRAINT "hub_report_subscription_scope_kind_check";--> statement-breakpoint
ALTER TABLE "hub_report_subscription" DROP CONSTRAINT "hub_report_subscription_scope_check";--> statement-breakpoint
UPDATE "hub_report_subscription" SET "scope_kind"='members' WHERE "scope_kind"='person';--> statement-breakpoint
ALTER TABLE "hub_report_subscription" DROP CONSTRAINT "hub_report_subscription_person_user_id_user_id_fkey";--> statement-breakpoint
ALTER TABLE "hub_report_subscription" DROP COLUMN "person_user_id";--> statement-breakpoint
ALTER TABLE "hub_report_subscription" ADD CONSTRAINT "hub_report_subscription_scope_kind_check" CHECK ("scope_kind" IN ('space','project','members'));--> statement-breakpoint
ALTER TABLE "hub_report_subscription" ADD CONSTRAINT "hub_report_subscription_scope_check" CHECK (("scope_kind" = 'space' AND "project_name" IS NULL)
        OR ("scope_kind" = 'project' AND "project_name" IS NOT NULL)
        OR ("scope_kind" = 'members' AND "project_name" IS NULL));--> statement-breakpoint
CREATE POLICY "hub_report_subscription_member_space_select" ON "hub_report_subscription_member" AS PERMISSIVE FOR SELECT TO public USING ("hub_report_subscription_member"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "hub_report_subscription_member"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "hub_report_subscription_member_space_insert" ON "hub_report_subscription_member" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("hub_report_subscription_member"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_report_subscription_member_space_update" ON "hub_report_subscription_member" AS PERMISSIVE FOR UPDATE TO public USING ("hub_report_subscription_member"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("hub_report_subscription_member"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_report_subscription_member_space_delete" ON "hub_report_subscription_member" AS PERMISSIVE FOR DELETE TO public USING ("hub_report_subscription_member"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "hub_report_subscription_member" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hub_report_subscription_member_owner_delivery_select"
ON "hub_report_subscription_member" AS PERMISSIVE FOR SELECT TO record_owner USING (true);--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.hub_report_delivery_candidates()
RETURNS TABLE (
  subscription_id uuid,
  space_id uuid,
  cadence text,
  hour integer,
  weekday text,
  zone text,
  created_at timestamp with time zone,
  last_period_end timestamp with time zone
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT s.id, s.space_id, s.cadence, s.hour, s.weekday, s.zone, s.created_at,
    max(d.period_end) AS last_period_end
  FROM public.hub_report_subscription s
  LEFT JOIN public.hub_send d ON d.subscription_id = s.id AND d.test = 0
  WHERE s.enabled = 1 AND s.deleted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM public.hub_report_subscription_recipient r
      WHERE r.subscription_id = s.id AND r.space_id = s.space_id
    )
  GROUP BY s.id, s.space_id, s.cadence, s.hour, s.weekday, s.zone, s.created_at;
$function$;

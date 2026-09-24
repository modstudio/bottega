ALTER TABLE "hub_report_subscription" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
WITH existing_person_subscription AS (
  SELECT "id","space_id","person_user_id" FROM "hub_report_subscription" WHERE "scope_kind"='person'
), migrated_subscription_member AS (
  INSERT INTO "hub_report_subscription_member" ("id","space_id","subscription_id","user_id","created_at")
  SELECT gen_random_uuid(),"space_id","id","person_user_id",now() FROM existing_person_subscription
  RETURNING "id"
)
SELECT count(*) FROM migrated_subscription_member;
--> statement-breakpoint
UPDATE "hub_report_subscription" SET "scope_kind"='members' WHERE "scope_kind"='person';
--> statement-breakpoint
ALTER TABLE "hub_report_subscription" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hub_report_subscription_member" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "hub_report_subscription_member_owner_delivery_select"
ON "hub_report_subscription_member" AS PERMISSIVE FOR SELECT TO record_owner USING (true);
--> statement-breakpoint
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

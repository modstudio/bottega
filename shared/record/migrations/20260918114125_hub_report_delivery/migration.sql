ALTER TABLE "hub_send" ADD COLUMN "subscription_id" uuid;--> statement-breakpoint
ALTER TABLE "hub_send" ADD COLUMN "period_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hub_send" ADD COLUMN "period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hub_send" ADD CONSTRAINT "hub_send_subscription_period_unique" UNIQUE("subscription_id","period_end");--> statement-breakpoint
ALTER TABLE "hub_send" ADD CONSTRAINT "hub_send_subscription_id_hub_report_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "hub_report_subscription"("id");--> statement-breakpoint
ALTER TABLE "hub_send" ADD CONSTRAINT "hub_send_subscription_period_check" CHECK (("subscription_id" IS NULL AND "period_start" IS NULL AND "period_end" IS NULL)
        OR ("subscription_id" IS NOT NULL AND "period_start" IS NOT NULL AND "period_end" IS NOT NULL AND "period_start" < "period_end"));--> statement-breakpoint
ALTER TABLE "hub_send" DROP CONSTRAINT "hub_send_status_check", ADD CONSTRAINT "hub_send_status_check" CHECK ("status" IN ('pending','sent','skipped','failed'));--> statement-breakpoint
CREATE POLICY "hub_send_space_update" ON "hub_send" AS PERMISSIVE FOR UPDATE TO public USING ("hub_send"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("hub_send"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "hub_report_subscription_owner_delivery_select" ON "hub_report_subscription"
AS PERMISSIVE FOR SELECT TO record_owner USING (enabled = 1 AND deleted_at IS NULL);
--> statement-breakpoint
CREATE POLICY "hub_send_owner_delivery_select" ON "hub_send"
AS PERMISSIVE FOR SELECT TO record_owner USING (subscription_id IS NOT NULL);
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
  LEFT JOIN public.hub_send d ON d.subscription_id = s.id
  WHERE s.enabled = 1 AND s.deleted_at IS NULL
  GROUP BY s.id, s.space_id, s.cadence, s.hour, s.weekday, s.zone, s.created_at;
$function$;
--> statement-breakpoint
ALTER FUNCTION public.hub_report_delivery_candidates() OWNER TO record_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.hub_report_delivery_candidates() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.hub_report_delivery_candidates() TO record_actor, record_owner;

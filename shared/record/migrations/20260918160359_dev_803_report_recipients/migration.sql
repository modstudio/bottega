CREATE TABLE "hub_report_subscription_recipient" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hub_report_subscription_recipient_unique" UNIQUE("subscription_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "hub_report_subscription_recipient" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hub_send_recipient" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"send_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hub_send_recipient_unique" UNIQUE("send_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "hub_send_recipient" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hub_report_subscription_recipient" ADD CONSTRAINT "hub_report_subscription_recipient_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "hub_report_subscription_recipient" ADD CONSTRAINT "hub_report_subscription_recipient_1J8jPMmb6EUn_fkey" FOREIGN KEY ("subscription_id") REFERENCES "hub_report_subscription"("id");--> statement-breakpoint
ALTER TABLE "hub_report_subscription_recipient" ADD CONSTRAINT "hub_report_subscription_recipient_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id");--> statement-breakpoint
ALTER TABLE "hub_send_recipient" ADD CONSTRAINT "hub_send_recipient_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "hub_send_recipient" ADD CONSTRAINT "hub_send_recipient_send_id_hub_send_id_fkey" FOREIGN KEY ("send_id") REFERENCES "hub_send"("id");--> statement-breakpoint
ALTER TABLE "hub_send_recipient" ADD CONSTRAINT "hub_send_recipient_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id");--> statement-breakpoint
WITH existing_subscription_recipient AS (
	SELECT "id","space_id","recipient_user_id","created_at" FROM "hub_report_subscription"
), migrated_subscription_recipient AS (
	INSERT INTO "hub_report_subscription_recipient" ("id","space_id","subscription_id","user_id","created_at")
	SELECT "id","space_id","id","recipient_user_id","created_at" FROM existing_subscription_recipient
	RETURNING "id"
)
SELECT count(*) FROM migrated_subscription_recipient;--> statement-breakpoint
WITH existing_send_recipient AS (
	SELECT se."id",se."space_id",su."recipient_user_id",u."name",u."email",se."created_at"
	FROM "hub_send" se
	JOIN "hub_report_subscription" su ON su."id"=se."subscription_id"
	JOIN "user" u ON u."id"=su."recipient_user_id"
), migrated_send_recipient AS (
	INSERT INTO "hub_send_recipient" ("id","space_id","send_id","user_id","name","email","created_at")
	SELECT "id","space_id","id","recipient_user_id","name","email","created_at"
	FROM existing_send_recipient
	RETURNING "id"
)
SELECT count(*) FROM migrated_send_recipient;--> statement-breakpoint
DROP POLICY "hub_report_setting_space_select" ON "hub_report_setting";--> statement-breakpoint
DROP POLICY "hub_report_setting_space_insert" ON "hub_report_setting";--> statement-breakpoint
DROP POLICY "hub_report_setting_space_update" ON "hub_report_setting";--> statement-breakpoint
DROP POLICY "hub_report_setting_space_delete" ON "hub_report_setting";--> statement-breakpoint
ALTER TABLE "hub_report_subscription" DROP CONSTRAINT "hub_report_subscription_recipient_user_id_user_id_fkey";--> statement-breakpoint
-- Hosted subscriptions and SES delivery own every former report-setting field.
DROP TABLE "hub_report_setting";--> statement-breakpoint
ALTER TABLE "hub_report_subscription" DROP COLUMN "recipient_user_id";--> statement-breakpoint
CREATE POLICY "hub_report_subscription_recipient_space_select" ON "hub_report_subscription_recipient" AS PERMISSIVE FOR SELECT TO public USING ("hub_report_subscription_recipient"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "hub_report_subscription_recipient"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "hub_report_subscription_recipient_space_insert" ON "hub_report_subscription_recipient" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("hub_report_subscription_recipient"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_report_subscription_recipient_space_update" ON "hub_report_subscription_recipient" AS PERMISSIVE FOR UPDATE TO public USING ("hub_report_subscription_recipient"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("hub_report_subscription_recipient"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_report_subscription_recipient_space_delete" ON "hub_report_subscription_recipient" AS PERMISSIVE FOR DELETE TO public USING ("hub_report_subscription_recipient"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_send_recipient_space_select" ON "hub_send_recipient" AS PERMISSIVE FOR SELECT TO public USING ("hub_send_recipient"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "hub_send_recipient"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "hub_send_recipient_space_insert" ON "hub_send_recipient" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("hub_send_recipient"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_send_recipient_space_update" ON "hub_send_recipient" AS PERMISSIVE FOR UPDATE TO public USING ("hub_send_recipient"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("hub_send_recipient"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_send_recipient_space_delete" ON "hub_send_recipient" AS PERMISSIVE FOR DELETE TO public USING ("hub_send_recipient"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "hub_report_subscription_recipient" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hub_send_recipient" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "hub_report_subscription_recipient_owner_delivery_select"
ON "hub_report_subscription_recipient" AS PERMISSIVE FOR SELECT TO record_owner USING (true);
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
    AND EXISTS (
      SELECT 1 FROM public.hub_report_subscription_recipient r
      WHERE r.subscription_id = s.id AND r.space_id = s.space_id
    )
  GROUP BY s.id, s.space_id, s.cadence, s.hour, s.weekday, s.zone, s.created_at;
$function$;

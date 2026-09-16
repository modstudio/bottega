UPDATE "space"
SET "slug" = 'bottega'
WHERE "id" = '01990000-0000-7000-8000-000000000001' AND "slug" IS NULL;

ALTER TABLE "space" ALTER COLUMN "slug" SET NOT NULL;
ALTER TABLE "space" ADD CONSTRAINT "space_slug_key" UNIQUE ("slug");
ALTER TABLE "invitation" FORCE ROW LEVEL SECURITY;

DROP POLICY "membership_space_select" ON "membership";
CREATE POLICY "membership_space_select" ON "membership" AS PERMISSIVE FOR SELECT TO public
USING (
  "membership"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid
  OR "membership"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid
);

DROP POLICY "space_space_select" ON "space";
CREATE POLICY "space_space_select" ON "space" AS PERMISSIVE FOR SELECT TO public
USING (
  "space"."id" = nullif(current_setting('app.space_id', true), '')::uuid
  OR EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "space"."id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
  )
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  session, account, verification, invitation
TO record_actor;
-- Machine registration and Better Auth sign-up are application acts. The actor may
-- create and update their user identity but cannot delete users or machines.
GRANT SELECT, INSERT, UPDATE ON TABLE "user" TO record_actor;
GRANT SELECT ON TABLE session, invitation TO record_reader;

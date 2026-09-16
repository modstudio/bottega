CREATE POLICY "invitation_invitee_select" ON "invitation" AS PERMISSIVE FOR SELECT TO public USING (lower("invitation"."email") = (
    SELECT lower(u.email) FROM "user" u
    WHERE u.id = nullif(current_setting('app.user_id', true), '')::uuid
  ));--> statement-breakpoint
CREATE POLICY "invitation_invitee_update" ON "invitation" AS PERMISSIVE FOR UPDATE TO public USING (lower("invitation"."email") = (
    SELECT lower(u.email) FROM "user" u
    WHERE u.id = nullif(current_setting('app.user_id', true), '')::uuid
  )) WITH CHECK (lower("invitation"."email") = (
    SELECT lower(u.email) FROM "user" u
    WHERE u.id = nullif(current_setting('app.user_id', true), '')::uuid
  ));
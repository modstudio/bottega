ALTER POLICY "hub_report_subscription_recipient_space_delete" ON "hub_report_subscription_recipient" TO public USING ((("hub_report_subscription_recipient"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "hub_report_subscription_recipient"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) OR (("hub_report_subscription_recipient"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND ("hub_report_subscription_recipient"."unsubscribe_token" = nullif(current_setting('app.unsubscribe_token', true), ''))));
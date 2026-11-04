CREATE POLICY "machine_public_key_owner_select" ON "machine_public_key" AS PERMISSIVE FOR SELECT TO "record_owner" USING (true);--> statement-breakpoint
CREATE POLICY "machine_public_key_owner_update" ON "machine_public_key" AS PERMISSIVE FOR UPDATE TO "record_owner" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "secret_dek_wrap_owner_select" ON "secret_dek_wrap" AS PERMISSIVE FOR SELECT TO "record_owner" USING (true);--> statement-breakpoint
CREATE POLICY "secret_dek_wrap_owner_delete" ON "secret_dek_wrap" AS PERMISSIVE FOR DELETE TO "record_owner" USING (true);
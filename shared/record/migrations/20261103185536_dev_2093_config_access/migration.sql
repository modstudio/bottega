CREATE TABLE "machine_key_claim_challenge" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"key_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"nonce_hash" bytea NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "machine_key_claim_challenge_key_id_check" CHECK (length("key_id") = 22 AND "key_id" ~ '^[A-Za-z0-9_-]{22}$'),
	CONSTRAINT "machine_key_claim_challenge_hash_length_check" CHECK (octet_length("nonce_hash") = 32)
);
--> statement-breakpoint
ALTER TABLE "machine_key_claim_challenge" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "membership" ADD COLUMN "config_access" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_public_key" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "machine_key_claim_challenge" ADD CONSTRAINT "machine_key_claim_challenge_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "machine_key_claim_challenge" ADD CONSTRAINT "machine_key_claim_challenge_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id");--> statement-breakpoint
ALTER TABLE "machine_key_claim_challenge" ADD CONSTRAINT "machine_key_claim_challenge_space_key_fk" FOREIGN KEY ("space_id","key_id") REFERENCES "machine_public_key"("space_id","key_id");--> statement-breakpoint
ALTER TABLE "machine_public_key" ADD CONSTRAINT "machine_public_key_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id");--> statement-breakpoint
CREATE POLICY "machine_key_claim_challenge_space_select" ON "machine_key_claim_challenge" AS PERMISSIVE FOR SELECT TO public USING ("machine_key_claim_challenge"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "machine_key_claim_challenge"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "machine_key_claim_challenge_space_insert" ON "machine_key_claim_challenge" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("machine_key_claim_challenge"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "machine_key_claim_challenge"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "machine_key_claim_challenge_space_update" ON "machine_key_claim_challenge" AS PERMISSIVE FOR UPDATE TO public USING (("machine_key_claim_challenge"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "machine_key_claim_challenge"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("machine_key_claim_challenge"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "machine_key_claim_challenge"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "machine_key_claim_challenge_space_delete" ON "machine_key_claim_challenge" AS PERMISSIVE FOR DELETE TO public USING (("machine_key_claim_challenge"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "machine_key_claim_challenge"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));
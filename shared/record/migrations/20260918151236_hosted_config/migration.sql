CREATE TABLE "config_entry" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"user_id" uuid,
	"key" text NOT NULL,
	"environment" text DEFAULT 'default' NOT NULL,
	"value" text NOT NULL,
	"row_version" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "config_entry_scope_unique" UNIQUE NULLS NOT DISTINCT("space_id","user_id","key","environment")
);
--> statement-breakpoint
ALTER TABLE "config_entry" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "config_secret" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"user_id" uuid,
	"key" text NOT NULL,
	"environment" text DEFAULT 'default' NOT NULL,
	"dek_id" uuid NOT NULL,
	"row_version" integer NOT NULL,
	"envelope" bytea NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "config_secret_scope_unique" UNIQUE NULLS NOT DISTINCT("space_id","user_id","key","environment")
);
--> statement-breakpoint
ALTER TABLE "config_secret" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "machine_public_key" (
	"space_id" uuid NOT NULL,
	"key_id" text NOT NULL,
	"public_key" bytea NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "machine_public_key_space_key_unique" UNIQUE("space_id","key_id"),
	CONSTRAINT "machine_public_key_key_id_check" CHECK (length("key_id") = 22 AND "key_id" ~ '^[A-Za-z0-9_-]{22}$'),
	CONSTRAINT "machine_public_key_length_check" CHECK (octet_length("public_key") = 32)
);
--> statement-breakpoint
ALTER TABLE "machine_public_key" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "secret_dek" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "secret_dek_space_version_unique" UNIQUE("space_id","version")
);
--> statement-breakpoint
ALTER TABLE "secret_dek" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "secret_dek_wrap" (
	"space_id" uuid NOT NULL,
	"dek_id" uuid,
	"recipient_key_id" text,
	"sender_key_id" text NOT NULL,
	"enc" bytea NOT NULL,
	"ciphertext" bytea NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "secret_dek_wrap_pkey" PRIMARY KEY("dek_id","recipient_key_id"),
	CONSTRAINT "secret_dek_wrap_recipient_key_id_check" CHECK (length("recipient_key_id") = 22 AND "recipient_key_id" ~ '^[A-Za-z0-9_-]{22}$'),
	CONSTRAINT "secret_dek_wrap_sender_key_id_check" CHECK (length("sender_key_id") = 22 AND "sender_key_id" ~ '^[A-Za-z0-9_-]{22}$')
);
--> statement-breakpoint
ALTER TABLE "secret_dek_wrap" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "config_entry" ADD CONSTRAINT "config_entry_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "config_entry" ADD CONSTRAINT "config_entry_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id");--> statement-breakpoint
ALTER TABLE "config_secret" ADD CONSTRAINT "config_secret_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "config_secret" ADD CONSTRAINT "config_secret_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id");--> statement-breakpoint
ALTER TABLE "config_secret" ADD CONSTRAINT "config_secret_dek_id_secret_dek_id_fkey" FOREIGN KEY ("dek_id") REFERENCES "secret_dek"("id");--> statement-breakpoint
ALTER TABLE "machine_public_key" ADD CONSTRAINT "machine_public_key_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "secret_dek" ADD CONSTRAINT "secret_dek_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "secret_dek_wrap" ADD CONSTRAINT "secret_dek_wrap_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "secret_dek_wrap" ADD CONSTRAINT "secret_dek_wrap_dek_id_secret_dek_id_fkey" FOREIGN KEY ("dek_id") REFERENCES "secret_dek"("id");--> statement-breakpoint
CREATE POLICY "config_entry_space_select" ON "config_entry" AS PERMISSIVE FOR SELECT TO public USING ("config_entry"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "config_entry"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "config_entry_space_insert" ON "config_entry" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("config_entry"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "config_entry_space_update" ON "config_entry" AS PERMISSIVE FOR UPDATE TO public USING ("config_entry"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("config_entry"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "config_entry_space_delete" ON "config_entry" AS PERMISSIVE FOR DELETE TO public USING ("config_entry"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "config_entry_user_scope" ON "config_entry" AS RESTRICTIVE FOR ALL TO public USING ("config_entry"."user_id" IS NULL OR "config_entry"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("config_entry"."user_id" IS NULL OR "config_entry"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "config_secret_actor_select" ON "config_secret" AS PERMISSIVE FOR SELECT TO "record_actor" USING (("config_secret"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "config_secret"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  )) AND ("config_secret"."user_id" IS NULL OR "config_secret"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "config_secret_actor_insert" ON "config_secret" AS PERMISSIVE FOR INSERT TO "record_actor" WITH CHECK (("config_secret"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND ("config_secret"."user_id" IS NULL OR "config_secret"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "config_secret_actor_update" ON "config_secret" AS PERMISSIVE FOR UPDATE TO "record_actor" USING (("config_secret"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND ("config_secret"."user_id" IS NULL OR "config_secret"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid)) WITH CHECK (("config_secret"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND ("config_secret"."user_id" IS NULL OR "config_secret"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "config_secret_actor_delete" ON "config_secret" AS PERMISSIVE FOR DELETE TO "record_actor" USING (("config_secret"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND ("config_secret"."user_id" IS NULL OR "config_secret"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "config_secret_reader_backstop" ON "config_secret" AS RESTRICTIVE FOR SELECT TO "record_reader" USING (false);--> statement-breakpoint
CREATE POLICY "machine_public_key_space_select" ON "machine_public_key" AS PERMISSIVE FOR SELECT TO public USING ("machine_public_key"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "machine_public_key"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "machine_public_key_space_insert" ON "machine_public_key" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("machine_public_key"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "machine_public_key_space_update" ON "machine_public_key" AS PERMISSIVE FOR UPDATE TO public USING ("machine_public_key"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("machine_public_key"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "machine_public_key_space_delete" ON "machine_public_key" AS PERMISSIVE FOR DELETE TO public USING ("machine_public_key"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "secret_dek_actor_select" ON "secret_dek" AS PERMISSIVE FOR SELECT TO "record_actor" USING (("secret_dek"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "secret_dek"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  )) AND (true));--> statement-breakpoint
CREATE POLICY "secret_dek_actor_insert" ON "secret_dek" AS PERMISSIVE FOR INSERT TO "record_actor" WITH CHECK (("secret_dek"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (true));--> statement-breakpoint
CREATE POLICY "secret_dek_actor_update" ON "secret_dek" AS PERMISSIVE FOR UPDATE TO "record_actor" USING (("secret_dek"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (true)) WITH CHECK (("secret_dek"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (true));--> statement-breakpoint
CREATE POLICY "secret_dek_actor_delete" ON "secret_dek" AS PERMISSIVE FOR DELETE TO "record_actor" USING (("secret_dek"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (true));--> statement-breakpoint
CREATE POLICY "secret_dek_reader_backstop" ON "secret_dek" AS RESTRICTIVE FOR SELECT TO "record_reader" USING (false);--> statement-breakpoint
CREATE POLICY "secret_dek_wrap_actor_select" ON "secret_dek_wrap" AS PERMISSIVE FOR SELECT TO "record_actor" USING (("secret_dek_wrap"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "secret_dek_wrap"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  )) AND (true));--> statement-breakpoint
CREATE POLICY "secret_dek_wrap_actor_insert" ON "secret_dek_wrap" AS PERMISSIVE FOR INSERT TO "record_actor" WITH CHECK (("secret_dek_wrap"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (true));--> statement-breakpoint
CREATE POLICY "secret_dek_wrap_actor_update" ON "secret_dek_wrap" AS PERMISSIVE FOR UPDATE TO "record_actor" USING (("secret_dek_wrap"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (true)) WITH CHECK (("secret_dek_wrap"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (true));--> statement-breakpoint
CREATE POLICY "secret_dek_wrap_actor_delete" ON "secret_dek_wrap" AS PERMISSIVE FOR DELETE TO "record_actor" USING (("secret_dek_wrap"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (true));--> statement-breakpoint
CREATE POLICY "secret_dek_wrap_reader_backstop" ON "secret_dek_wrap" AS RESTRICTIVE FOR SELECT TO "record_reader" USING (false);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  config_entry, config_secret, secret_dek_wrap, machine_public_key
TO record_actor;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE secret_dek TO record_actor;
--> statement-breakpoint
REVOKE DELETE ON TABLE secret_dek FROM record_actor;
--> statement-breakpoint
GRANT SELECT ON TABLE config_entry, machine_public_key TO record_reader;
--> statement-breakpoint
REVOKE ALL ON TABLE config_secret, secret_dek, secret_dek_wrap FROM record_reader;

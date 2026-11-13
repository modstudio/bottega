CREATE TABLE "machine_trust_log" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"hash" bytea NOT NULL,
	"prev_hash" bytea,
	"entry" bytea NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "machine_trust_log_space_seq_unique" UNIQUE("space_id","seq"),
	CONSTRAINT "machine_trust_log_space_hash_unique" UNIQUE("space_id","hash"),
	CONSTRAINT "machine_trust_log_hash_length_check" CHECK (octet_length("hash") = 32),
	CONSTRAINT "machine_trust_log_prev_hash_check" CHECK (("seq" = 0 AND "prev_hash" IS NULL) OR ("seq" > 0 AND octet_length("prev_hash") = 32))
);
--> statement-breakpoint
ALTER TABLE "machine_trust_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "machine_trust_log" ADD CONSTRAINT "machine_trust_log_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
CREATE POLICY "machine_trust_log_space_select" ON "machine_trust_log" AS PERMISSIVE FOR SELECT TO public USING ("machine_trust_log"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "machine_trust_log"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "machine_trust_log_space_insert" ON "machine_trust_log" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("machine_trust_log"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "machine_trust_log"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "machine_trust_log_owner_select" ON "machine_trust_log" AS PERMISSIVE FOR SELECT TO "record_owner" USING (true);--> statement-breakpoint
CREATE POLICY "machine_trust_log_owner_delete" ON "machine_trust_log" AS PERMISSIVE FOR DELETE TO "record_owner" USING (true);
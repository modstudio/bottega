CREATE SEQUENCE "public"."board_message_revision" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "board_claim" (
	"id" uuid PRIMARY KEY,
	"project_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_value" text NOT NULL,
	"holder_user_id" uuid NOT NULL,
	"holder_session" text,
	"note" text,
	"run_id" uuid,
	"duration_ms" bigint NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"renewed_at" timestamp with time zone NOT NULL,
	"lapses_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"superseded_by_claim_id" uuid,
	CONSTRAINT "board_claim_subject_kind_check" CHECK ("subject_kind" IN ('task','path','resource')),
	CONSTRAINT "board_claim_close_check" CHECK (("closed_at" IS NULL AND "close_reason" IS NULL) OR
          ("closed_at" IS NOT NULL AND "close_reason" IS NOT NULL)),
	CONSTRAINT "board_claim_close_reason_check" CHECK ("close_reason" IS NULL OR "close_reason" IN
          ('released','lapsed','run-ended','task-closed','taken-over'))
);
--> statement-breakpoint
ALTER TABLE "board_claim" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "board_message" (
	"id" uuid PRIMARY KEY,
	"author_user_id" uuid NOT NULL,
	"author_session" text,
	"author_harness" text,
	"author_machine_id" uuid,
	"author_run_id" uuid,
	"kind" text NOT NULL,
	"thread_root_id" uuid,
	"audience" text,
	"title" text,
	"body" text NOT NULL,
	"ack_required" boolean NOT NULL,
	"ack_deadline" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"accepted_reply_id" uuid,
	"accepted_by_user_id" uuid,
	"accepted_at" timestamp with time zone,
	"note_id" uuid,
	"note_pending_error" text,
	"note_filing_started_at" timestamp with time zone,
	"claim_id" uuid,
	"scope_project_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"recipient_user_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"revision" bigint DEFAULT nextval('board_message_revision') NOT NULL,
	CONSTRAINT "board_message_kind_check" CHECK ("kind" IN ('notice','suggestion','question','reply')),
	CONSTRAINT "board_message_reply_shape_check" CHECK (("kind" = 'reply' AND "thread_root_id" IS NOT NULL
          AND "audience" IS NULL AND "title" IS NULL
          AND "ack_required" = false AND "ack_deadline" IS NULL
          AND "expires_at" IS NULL) OR
          ("kind" <> 'reply' AND "thread_root_id" IS NULL
          AND "audience" IS NOT NULL AND "title" IS NOT NULL
          AND "expires_at" IS NOT NULL)),
	CONSTRAINT "board_message_acceptance_check" CHECK (("accepted_reply_id" IS NULL AND "accepted_by_user_id" IS NULL
          AND "accepted_at" IS NULL) OR
          ("kind" = 'question' AND "accepted_reply_id" IS NOT NULL
          AND "accepted_by_user_id" IS NOT NULL AND "accepted_at" IS NOT NULL)),
	CONSTRAINT "board_message_note_check" CHECK ("kind" = 'question' OR ("note_id" IS NULL
          AND "note_pending_error" IS NULL AND "note_filing_started_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "board_message" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "board_message_tag" (
	"message_id" uuid,
	"kind" text,
	"value" text,
	"origin" text,
	CONSTRAINT "board_message_tag_pkey" PRIMARY KEY("message_id","kind","value","origin"),
	CONSTRAINT "board_message_tag_kind_check" CHECK ("kind" IN ('task','path','topic')),
	CONSTRAINT "board_message_tag_origin_check" CHECK ("origin" IN ('sender','inferred'))
);
--> statement-breakpoint
ALTER TABLE "board_message_tag" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "board_receipt" (
	"message_id" uuid,
	"reader_user_id" uuid,
	"reader_session" text,
	"audience_at_posting" boolean NOT NULL,
	"delivered_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	CONSTRAINT "board_receipt_pkey" PRIMARY KEY("message_id","reader_user_id","reader_session")
);
--> statement-breakpoint
ALTER TABLE "board_receipt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "board_claim_project_subject_idx" ON "board_claim" ("project_id","subject_kind","subject_value","closed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "board_claim_live_subject_unique" ON "board_claim" ("project_id","subject_kind","subject_value") WHERE "closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "board_claim_run_idx" ON "board_claim" ("run_id","closed_at");--> statement-breakpoint
CREATE INDEX "board_claim_superseded_idx" ON "board_claim" ("superseded_by_claim_id");--> statement-breakpoint
CREATE INDEX "board_message_revision_idx" ON "board_message" ("revision");--> statement-breakpoint
CREATE INDEX "board_message_delivery_idx" ON "board_message" ("expires_at","withdrawn_at","created_at");--> statement-breakpoint
CREATE INDEX "board_message_author_rate_idx" ON "board_message" ("author_user_id","author_session","author_run_id","created_at");--> statement-breakpoint
CREATE INDEX "board_message_thread_idx" ON "board_message" ("thread_root_id","created_at","id");--> statement-breakpoint
CREATE INDEX "board_message_tag_message_idx" ON "board_message_tag" ("message_id");--> statement-breakpoint
ALTER TABLE "board_claim" ADD CONSTRAINT "board_claim_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
ALTER TABLE "board_claim" ADD CONSTRAINT "board_claim_holder_user_id_user_id_fkey" FOREIGN KEY ("holder_user_id") REFERENCES "user"("id");--> statement-breakpoint
ALTER TABLE "board_claim" ADD CONSTRAINT "board_claim_run_id_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("id");--> statement-breakpoint
ALTER TABLE "board_claim" ADD CONSTRAINT "board_claim_superseded_by_claim_id_board_claim_id_fkey" FOREIGN KEY ("superseded_by_claim_id") REFERENCES "board_claim"("id");--> statement-breakpoint
ALTER TABLE "board_message" ADD CONSTRAINT "board_message_author_user_id_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "user"("id");--> statement-breakpoint
ALTER TABLE "board_message" ADD CONSTRAINT "board_message_author_machine_id_machine_id_fkey" FOREIGN KEY ("author_machine_id") REFERENCES "machine"("id");--> statement-breakpoint
ALTER TABLE "board_message" ADD CONSTRAINT "board_message_author_run_id_run_id_fkey" FOREIGN KEY ("author_run_id") REFERENCES "run"("id");--> statement-breakpoint
ALTER TABLE "board_message" ADD CONSTRAINT "board_message_thread_root_id_board_message_id_fkey" FOREIGN KEY ("thread_root_id") REFERENCES "board_message"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "board_message" ADD CONSTRAINT "board_message_accepted_reply_id_board_message_id_fkey" FOREIGN KEY ("accepted_reply_id") REFERENCES "board_message"("id");--> statement-breakpoint
ALTER TABLE "board_message" ADD CONSTRAINT "board_message_accepted_by_user_id_user_id_fkey" FOREIGN KEY ("accepted_by_user_id") REFERENCES "user"("id");--> statement-breakpoint
ALTER TABLE "board_message" ADD CONSTRAINT "board_message_claim_id_board_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "board_claim"("id");--> statement-breakpoint
ALTER TABLE "board_message_tag" ADD CONSTRAINT "board_message_tag_message_id_board_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "board_message"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "board_receipt" ADD CONSTRAINT "board_receipt_message_id_board_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "board_message"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "board_receipt" ADD CONSTRAINT "board_receipt_reader_user_id_user_id_fkey" FOREIGN KEY ("reader_user_id") REFERENCES "user"("id");--> statement-breakpoint
CREATE POLICY "board_claim_actor_select" ON "board_claim" AS PERMISSIVE FOR SELECT TO "record_actor" USING (EXISTS (
      SELECT 1 FROM "project" p
      JOIN "membership" m ON m.space_id = p.space_id
      WHERE p.id = "board_claim"."project_id" AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
    ));--> statement-breakpoint
CREATE POLICY "board_claim_actor_insert" ON "board_claim" AS PERMISSIVE FOR INSERT TO "record_actor" WITH CHECK ("board_claim"."holder_user_id" = nullif(current_setting('app.user_id', true), '')::uuid AND EXISTS (
      SELECT 1 FROM "project" p
      JOIN "membership" m ON m.space_id = p.space_id
      WHERE p.id = "board_claim"."project_id" AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.permission = 'write'
    ));--> statement-breakpoint
CREATE POLICY "board_claim_actor_update" ON "board_claim" AS PERMISSIVE FOR UPDATE TO "record_actor" USING (EXISTS (
      SELECT 1 FROM "project" p
      JOIN "membership" m ON m.space_id = p.space_id
      WHERE p.id = "board_claim"."project_id" AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.permission = 'write'
    )) WITH CHECK (EXISTS (
      SELECT 1 FROM "project" p
      JOIN "membership" m ON m.space_id = p.space_id
      WHERE p.id = "board_claim"."project_id" AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.permission = 'write'
    ));--> statement-breakpoint
CREATE POLICY "board_message_actor_select" ON "board_message" AS PERMISSIVE FOR SELECT TO "record_actor" USING ("board_message"."author_user_id" = nullif(current_setting('app.user_id', true), '')::uuid OR
      (cardinality("board_message"."scope_project_ids") > 0 AND NOT EXISTS (
    SELECT 1 FROM unnest("board_message"."scope_project_ids") AS scoped(project_id)
    WHERE NOT EXISTS (
      SELECT 1 FROM "project" p
      JOIN "membership" m ON m.space_id = p.space_id
      WHERE p.id = scoped.project_id AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
    )
  )) OR
      (nullif(current_setting('app.user_id', true), '')::uuid = ANY("board_message"."recipient_user_ids") AND NOT EXISTS (
    SELECT 1 FROM unnest("board_message"."scope_project_ids") AS scoped(project_id)
    WHERE NOT EXISTS (
      SELECT 1 FROM "project" p
      JOIN "membership" m ON m.space_id = p.space_id
      WHERE p.id = scoped.project_id AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
    )
  )));--> statement-breakpoint
CREATE POLICY "board_message_actor_insert" ON "board_message" AS PERMISSIVE FOR INSERT TO "record_actor" WITH CHECK ("board_message"."author_user_id" = nullif(current_setting('app.user_id', true), '')::uuid AND NOT EXISTS (
    SELECT 1 FROM unnest("board_message"."scope_project_ids") AS scoped(project_id)
    WHERE NOT EXISTS (
      SELECT 1 FROM "project" p
      JOIN "membership" m ON m.space_id = p.space_id
      WHERE p.id = scoped.project_id AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.permission = 'write'
    )
  ));--> statement-breakpoint
CREATE POLICY "board_message_actor_update" ON "board_message" AS PERMISSIVE FOR UPDATE TO "record_actor" USING ("board_message"."author_user_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("board_message"."author_user_id" = nullif(current_setting('app.user_id', true), '')::uuid AND NOT EXISTS (
    SELECT 1 FROM unnest("board_message"."scope_project_ids") AS scoped(project_id)
    WHERE NOT EXISTS (
      SELECT 1 FROM "project" p
      JOIN "membership" m ON m.space_id = p.space_id
      WHERE p.id = scoped.project_id AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.permission = 'write'
    )
  ));--> statement-breakpoint
CREATE POLICY "board_message_actor_delete" ON "board_message" AS PERMISSIVE FOR DELETE TO "record_actor" USING ("board_message"."author_user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "board_message_tag_actor_select" ON "board_message_tag" AS PERMISSIVE FOR SELECT TO "record_actor" USING (EXISTS (
      SELECT 1 FROM "board_message" message WHERE message.id = "board_message_tag"."message_id"
    ));--> statement-breakpoint
CREATE POLICY "board_message_tag_actor_insert" ON "board_message_tag" AS PERMISSIVE FOR INSERT TO "record_actor" WITH CHECK (EXISTS (
      SELECT 1 FROM "board_message" message
      WHERE message.id = "board_message_tag"."message_id" AND message.author_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    ));--> statement-breakpoint
CREATE POLICY "board_message_tag_actor_update" ON "board_message_tag" AS PERMISSIVE FOR UPDATE TO "record_actor" USING (EXISTS (
      SELECT 1 FROM "board_message" message
      WHERE message.id = "board_message_tag"."message_id" AND message.author_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    )) WITH CHECK (EXISTS (
      SELECT 1 FROM "board_message" message
      WHERE message.id = "board_message_tag"."message_id" AND message.author_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    ));--> statement-breakpoint
CREATE POLICY "board_message_tag_actor_delete" ON "board_message_tag" AS PERMISSIVE FOR DELETE TO "record_actor" USING (EXISTS (
      SELECT 1 FROM "board_message" message
      WHERE message.id = "board_message_tag"."message_id" AND message.author_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    ));--> statement-breakpoint
CREATE POLICY "board_receipt_actor_select" ON "board_receipt" AS PERMISSIVE FOR SELECT TO "record_actor" USING ("board_receipt"."reader_user_id" = nullif(current_setting('app.user_id', true), '')::uuid OR EXISTS (
      SELECT 1 FROM "board_message" message
      WHERE message.id = "board_receipt"."message_id" AND message.author_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    ));--> statement-breakpoint
CREATE POLICY "board_receipt_actor_insert" ON "board_receipt" AS PERMISSIVE FOR INSERT TO "record_actor" WITH CHECK ("board_receipt"."reader_user_id" = nullif(current_setting('app.user_id', true), '')::uuid AND EXISTS (
      SELECT 1 FROM "board_message" message WHERE message.id = "board_receipt"."message_id"
    ));--> statement-breakpoint
CREATE POLICY "board_receipt_actor_update" ON "board_receipt" AS PERMISSIVE FOR UPDATE TO "record_actor" USING ("board_receipt"."reader_user_id" = nullif(current_setting('app.user_id', true), '')::uuid AND EXISTS (
      SELECT 1 FROM "board_message" message WHERE message.id = "board_receipt"."message_id"
    )) WITH CHECK ("board_receipt"."reader_user_id" = nullif(current_setting('app.user_id', true), '')::uuid AND EXISTS (
      SELECT 1 FROM "board_message" message WHERE message.id = "board_receipt"."message_id"
    ));
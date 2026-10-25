ALTER TABLE "seq" ADD COLUMN "id" uuid DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "question_mutation_audit" ADD COLUMN "id" uuid DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "public_doc_space" ADD COLUMN "id" uuid DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "hub_change" ADD COLUMN "id" uuid DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "hub_change_head" ADD COLUMN "id" uuid DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "machine_public_key" ADD COLUMN "id" uuid DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "secret_dek_wrap" ADD COLUMN "id" uuid DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "board_message_tag" ADD COLUMN "id" uuid DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "board_receipt" ADD COLUMN "id" uuid DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "question_mutation_audit" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "machine_public_key" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "seq" DROP CONSTRAINT "seq_pkey";--> statement-breakpoint
ALTER TABLE "seq" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "public_doc_space" DROP CONSTRAINT "public_doc_space_pkey";--> statement-breakpoint
ALTER TABLE "public_doc_space" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "hub_change" DROP CONSTRAINT "hub_change_pkey";--> statement-breakpoint
ALTER TABLE "hub_change" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "secret_dek_wrap" DROP CONSTRAINT "secret_dek_wrap_pkey";--> statement-breakpoint
ALTER TABLE "secret_dek_wrap" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "board_message_tag" DROP CONSTRAINT "board_message_tag_pkey";--> statement-breakpoint
ALTER TABLE "board_message_tag" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "board_receipt" DROP CONSTRAINT "board_receipt_pkey";--> statement-breakpoint
ALTER TABLE "board_receipt" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "hub_change_head" DROP CONSTRAINT "hub_change_head_pkey";--> statement-breakpoint
ALTER TABLE "hub_change_head" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "seq" ADD CONSTRAINT "seq_space_project_name_unique" UNIQUE("space_id","project_id","name");--> statement-breakpoint
ALTER TABLE "public_doc_space" ADD CONSTRAINT "public_doc_space_space_project_unique" UNIQUE("space_id","project_id");--> statement-breakpoint
ALTER TABLE "hub_change" ADD CONSTRAINT "hub_change_space_sequence_unique" UNIQUE("space_id","sequence");--> statement-breakpoint
ALTER TABLE "hub_change_head" ADD CONSTRAINT "hub_change_head_space_unique" UNIQUE("space_id");--> statement-breakpoint
ALTER TABLE "secret_dek_wrap" ADD CONSTRAINT "secret_dek_wrap_space_dek_recipient_sender_unique" UNIQUE("space_id","dek_id","recipient_key_id","sender_key_id");--> statement-breakpoint
ALTER TABLE "board_message_tag" ADD CONSTRAINT "board_message_tag_message_kind_value_origin_unique" UNIQUE("message_id","kind","value","origin");--> statement-breakpoint
ALTER TABLE "board_receipt" ADD CONSTRAINT "board_receipt_message_reader_session_unique" UNIQUE("message_id","reader_user_id","reader_session");
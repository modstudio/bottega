ALTER TABLE "seq" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "question_mutation_audit" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "public_doc_space" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "hub_change" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "hub_change_head" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "machine_public_key" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "secret_dek_wrap" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "board_message_tag" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "board_receipt" ALTER COLUMN "id" DROP DEFAULT;
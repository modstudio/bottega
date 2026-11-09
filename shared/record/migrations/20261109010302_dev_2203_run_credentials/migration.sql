ALTER TABLE "run" ADD COLUMN "credential_id" uuid;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "credential_payer" text;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "credential_binding" text;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_credential_payer_check" CHECK ("credential_payer" IS NULL OR "credential_payer" IN ('personal', 'shared'));--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_credential_binding_check" CHECK ("credential_binding" IS NULL OR "credential_binding" IN ('space', 'project'));
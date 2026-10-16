ALTER TABLE "run" DROP CONSTRAINT "run_machine_local_unique";--> statement-breakpoint
ALTER TABLE "question" DROP CONSTRAINT "question_machine_local_unique";--> statement-breakpoint
ALTER TABLE "review" DROP CONSTRAINT "review_machine_local_unique";--> statement-breakpoint
ALTER TABLE "review_finding" DROP CONSTRAINT "review_finding_machine_local_unique";--> statement-breakpoint
ALTER TABLE "review_lens" DROP CONSTRAINT "review_lens_machine_local_unique";--> statement-breakpoint
ALTER TABLE "review_read" DROP CONSTRAINT "review_read_machine_local_unique";--> statement-breakpoint
ALTER TABLE "release" DROP CONSTRAINT "release_machine_local_unique";--> statement-breakpoint
ALTER TABLE "contention" DROP CONSTRAINT "contention_machine_local_unique";--> statement-breakpoint
ALTER TABLE "landing" DROP CONSTRAINT "landing_machine_local_unique";--> statement-breakpoint
ALTER TABLE "landing_override" DROP CONSTRAINT "landing_override_machine_local_unique";--> statement-breakpoint
ALTER TABLE "landing_review_carry" DROP CONSTRAINT "landing_review_carry_machine_local_unique";--> statement-breakpoint
ALTER TABLE "landing_triage_snapshot" DROP CONSTRAINT "landing_triage_snapshot_machine_local_unique";--> statement-breakpoint
ALTER TABLE "test_flake" DROP CONSTRAINT "test_flake_machine_local_unique";--> statement-breakpoint
ALTER TABLE "run" ALTER COLUMN "local_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "question" ALTER COLUMN "local_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "review" ALTER COLUMN "local_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "review_finding" ALTER COLUMN "local_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "review_lens" ALTER COLUMN "local_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "review_read" ALTER COLUMN "local_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "release" ALTER COLUMN "local_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "contention" ALTER COLUMN "local_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "landing" ALTER COLUMN "local_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "landing_override" ALTER COLUMN "local_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "landing_review_carry" ALTER COLUMN "local_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "landing_triage_snapshot" ALTER COLUMN "local_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "test_flake" ALTER COLUMN "local_id" DROP NOT NULL;
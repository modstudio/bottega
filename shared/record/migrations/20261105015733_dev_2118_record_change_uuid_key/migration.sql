ALTER TABLE "record_change" ADD COLUMN "id" uuid DEFAULT public.record_uuid_v7();--> statement-breakpoint
ALTER TABLE "record_change_horizon" ADD COLUMN "id" uuid DEFAULT public.record_uuid_v7();--> statement-breakpoint
ALTER TABLE "record_change" DROP CONSTRAINT "record_change_pkey";--> statement-breakpoint
ALTER TABLE "record_change" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "record_change_horizon" DROP CONSTRAINT "record_change_horizon_pkey";--> statement-breakpoint
ALTER TABLE "record_change_horizon" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "record_change" ADD CONSTRAINT "record_change_seq_key" UNIQUE("seq");--> statement-breakpoint
ALTER TABLE "record_change_horizon" ADD CONSTRAINT "record_change_horizon_singleton_key" UNIQUE("singleton");
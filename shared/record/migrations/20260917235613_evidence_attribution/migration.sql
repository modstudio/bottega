ALTER TABLE "run" ADD COLUMN "started_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "hub_interval" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_started_by_user_id_user_id_fkey" FOREIGN KEY ("started_by_user_id") REFERENCES "user"("id");--> statement-breakpoint
ALTER TABLE "hub_interval" ADD CONSTRAINT "hub_interval_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id");
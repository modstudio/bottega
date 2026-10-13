ALTER TABLE "hub_day" ADD COLUMN "machine_id" uuid;--> statement-breakpoint
ALTER TABLE "hub_day" DROP CONSTRAINT "hub_day_natural_key";--> statement-breakpoint
ALTER TABLE "hub_day" ADD CONSTRAINT "hub_day_natural_key" UNIQUE("space_id","machine_id","day");--> statement-breakpoint
ALTER TABLE "hub_day" ADD CONSTRAINT "hub_day_machine_id_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machine"("id");
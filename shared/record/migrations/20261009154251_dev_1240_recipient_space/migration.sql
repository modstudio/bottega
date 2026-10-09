ALTER TABLE "hub_send_recipient" DROP CONSTRAINT "hub_send_recipient_send_id_hub_send_id_fkey";--> statement-breakpoint
ALTER TABLE "hub_send" ADD CONSTRAINT "hub_send_space_id_unique" UNIQUE("space_id","id");--> statement-breakpoint
ALTER TABLE "hub_send_recipient" ADD CONSTRAINT "hub_send_recipient_space_send_fk" FOREIGN KEY ("space_id","send_id") REFERENCES "hub_send"("space_id","id");
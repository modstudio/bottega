ALTER TABLE "port_pair" DROP CONSTRAINT "port_pair_same_space_source_project_fk";--> statement-breakpoint
ALTER TABLE "port_ref_source" DROP CONSTRAINT "port_ref_source_same_space_source_project_fk";--> statement-breakpoint
ALTER TABLE "port_pair" ADD CONSTRAINT "port_pair_source_project_fk" FOREIGN KEY ("source_project_id") REFERENCES "project"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "port_ref_source" ADD CONSTRAINT "port_ref_source_source_project_fk" FOREIGN KEY ("source_project_id") REFERENCES "project"("id") ON DELETE RESTRICT;
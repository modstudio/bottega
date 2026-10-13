ALTER TABLE "board_message" ADD COLUMN "author_project_id" uuid;--> statement-breakpoint
ALTER TABLE "board_message" ADD CONSTRAINT "board_message_author_project_id_project_id_fkey" FOREIGN KEY ("author_project_id") REFERENCES "project"("id") ON DELETE SET NULL;

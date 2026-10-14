ALTER TABLE "board_message" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "board_message" ADD CONSTRAINT "board_message_purpose_check" CHECK (("kind" = 'reply' AND "purpose" IS NULL) OR
          ("kind" <> 'reply' AND "purpose" IN ('information','request','standing')));
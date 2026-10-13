ALTER TABLE "board_message" DROP CONSTRAINT "board_message_purpose_check", ADD CONSTRAINT "board_message_purpose_check" CHECK (("kind" = 'reply' AND "purpose" IS NULL) OR
          ("kind" <> 'reply' AND "purpose" IS NOT NULL
            AND "purpose" IN ('information','request','standing')));
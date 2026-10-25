ALTER TABLE "board_message" DROP CONSTRAINT "board_message_reply_shape_check", ADD CONSTRAINT "board_message_reply_shape_check" CHECK (("kind" = 'reply' AND "thread_root_id" IS NOT NULL
          AND ("audience" IS NULL OR "audience" IN ('participants','acknowledged','audience','operator')
            OR "audience" LIKE 'session:%' OR "audience" LIKE 'run:%')
          AND "title" IS NULL
          AND "ack_required" = false AND "ack_deadline" IS NULL
          AND "expires_at" IS NULL) OR
          ("kind" <> 'reply' AND "thread_root_id" IS NULL
          AND "audience" IS NOT NULL AND "title" IS NOT NULL
          AND "expires_at" IS NOT NULL));
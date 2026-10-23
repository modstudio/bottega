ALTER TABLE probe ADD COLUMN pre_command_head_commit TEXT;
--> statement-breakpoint
-- Before this column existed, head_commit held the pre-command head.
-- BACKFILL
UPDATE probe SET pre_command_head_commit=head_commit WHERE pre_command_head_commit IS NULL;
-- /BACKFILL

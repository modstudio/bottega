ALTER TABLE probe ADD COLUMN pre_command_head_commit TEXT;

-- BACKFILL: before this column existed, head_commit held the pre-command head.
UPDATE probe SET pre_command_head_commit=head_commit WHERE pre_command_head_commit IS NULL;

ALTER TABLE workflow_cursor ADD COLUMN handed_off_from_record_id TEXT;
CREATE UNIQUE INDEX workflow_cursor_handed_off_from_record_id_unique
  ON workflow_cursor(handed_off_from_record_id)
  WHERE handed_off_from_record_id IS NOT NULL;

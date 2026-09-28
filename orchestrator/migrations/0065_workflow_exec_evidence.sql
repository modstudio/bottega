ALTER TABLE probe ADD COLUMN kind TEXT NOT NULL DEFAULT 'probe'
  CHECK (kind IN ('probe','exec'));

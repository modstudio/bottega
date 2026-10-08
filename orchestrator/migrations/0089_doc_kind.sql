ALTER TABLE doc ADD COLUMN kind TEXT NOT NULL DEFAULT 'working'
  CHECK (kind IN ('working','article'));

ALTER TABLE doc_revision ADD COLUMN kind TEXT NOT NULL DEFAULT 'working'
  CHECK (kind IN ('working','article'));

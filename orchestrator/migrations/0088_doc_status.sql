ALTER TABLE doc ADD COLUMN status TEXT NOT NULL DEFAULT 'current'
  CHECK (status IN ('draft','current','superseded','archived'));
ALTER TABLE doc ADD COLUMN replacement_slug TEXT;

ALTER TABLE doc_revision ADD COLUMN status TEXT NOT NULL DEFAULT 'current'
  CHECK (status IN ('draft','current','superseded','archived'));
ALTER TABLE doc_revision ADD COLUMN replacement_slug TEXT;

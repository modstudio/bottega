ALTER TABLE run ADD COLUMN executor TEXT NOT NULL DEFAULT 'external'
  CHECK (executor IN ('external', 'harness'));

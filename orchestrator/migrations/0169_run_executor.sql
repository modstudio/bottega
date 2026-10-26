ALTER TABLE run ADD COLUMN executor TEXT NOT NULL DEFAULT 'external'
  CHECK (executor IN ('external', 'harness'));

ALTER TABLE run ADD COLUMN harness_wall_bound_ms INTEGER;

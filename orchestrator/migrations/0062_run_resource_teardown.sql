ALTER TABLE run ADD COLUMN resource_teardown TEXT
  CHECK (resource_teardown IN ('pending','done'));

ALTER TABLE gate_execution ADD COLUMN base_refresh_elapsed_ms INTEGER
  CHECK (base_refresh_elapsed_ms IS NULL OR base_refresh_elapsed_ms >= 0);
ALTER TABLE gate_execution ADD COLUMN base_refresh_result TEXT;

ALTER TABLE run ADD COLUMN quota_used_percent_start REAL;
ALTER TABLE run ADD COLUMN quota_used_percent_end REAL;
ALTER TABLE run ADD COLUMN quota_window_minutes INTEGER;
ALTER TABLE run ADD COLUMN quota_resets_at INTEGER;

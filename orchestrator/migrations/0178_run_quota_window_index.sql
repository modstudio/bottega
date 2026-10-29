CREATE INDEX IF NOT EXISTS run_quota_window_readings
ON run(quota_resets_at DESC, agent)
WHERE quota_resets_at IS NOT NULL;

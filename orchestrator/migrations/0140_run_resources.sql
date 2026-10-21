ALTER TABLE run ADD COLUMN resource_cpu_ms INTEGER;
ALTER TABLE run ADD COLUMN resource_peak_rss_bytes INTEGER;
ALTER TABLE run ADD COLUMN resource_samples INTEGER;
ALTER TABLE run ADD COLUMN resource_source TEXT CHECK (resource_source IN ('sampled','rusage','both'));

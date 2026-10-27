CREATE INDEX IF NOT EXISTS run_running_repository_idx
ON run(host_wait_since, record_id)
WHERE status='running' AND worktree IS NOT NULL;

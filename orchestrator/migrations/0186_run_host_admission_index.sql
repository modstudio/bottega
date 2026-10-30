DROP INDEX run_running_repository_idx;
CREATE INDEX run_running_repository_idx
ON run(host_wait_since, record_id)
WHERE status='running';

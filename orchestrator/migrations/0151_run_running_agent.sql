CREATE INDEX run_running_agent
ON run(number, agent, record_id)
WHERE status = 'running' AND probe = 0;

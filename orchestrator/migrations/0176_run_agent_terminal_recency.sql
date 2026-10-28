CREATE INDEX IF NOT EXISTS run_agent_terminal_recency
ON run(agent, julianday(started_at) + latency_ms / 86400000.0 DESC, record_id DESC)
WHERE status IN ('ok','failed') AND latency_ms IS NOT NULL;

CREATE INDEX IF NOT EXISTS run_agent_terminal_category_recency
ON run(agent, status, failure_kind,
       julianday(started_at) + latency_ms / 86400000.0 DESC, record_id DESC)
WHERE status IN ('ok','failed') AND latency_ms IS NOT NULL;

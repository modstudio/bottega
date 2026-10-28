CREATE INDEX IF NOT EXISTS run_agent_terminal_recency
ON run(agent, started_at DESC, record_id DESC)
WHERE status IN ('ok','failed') AND latency_ms IS NOT NULL;

CREATE INDEX IF NOT EXISTS run_agent_terminal_category_recency
ON run(agent, status, failure_kind, started_at DESC, record_id DESC)
WHERE status IN ('ok','failed') AND latency_ms IS NOT NULL;

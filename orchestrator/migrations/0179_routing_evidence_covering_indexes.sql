CREATE INDEX run_routing_evidence_cover
ON run (
  job,
  prompt_bytes,
  agent,
  model,
  started_at DESC,
  record_id DESC,
  stack,
  status,
  failure_kind,
  vendor_tokens,
  vendor_cost_usd,
  model_calls,
  peak_call_tokens,
  probe,
  evidence_excluded,
  executor,
  parent_run_record_id
)
WHERE status IN ('ok','failed','stale')
  AND probe = 0
  AND evidence_excluded IS NULL
  AND executor <> 'harness'
  AND parent_run_record_id IS NULL;
--> statement-breakpoint
CREATE INDEX run_routing_latency_cover
ON run (
  job,
  prompt_bytes,
  stack,
  agent,
  latency_ms,
  record_id,
  status,
  probe
)
WHERE status = 'ok' AND probe = 0 AND latency_ms IS NOT NULL;
--> statement-breakpoint
CREATE INDEX run_routing_prompt_bucket_cover
ON run (job, prompt_bytes, status, probe, evidence_excluded, executor, parent_run_record_id, agent)
WHERE status IN ('ok','failed','stale')
  AND probe = 0
  AND evidence_excluded IS NULL
  AND executor <> 'harness'
  AND parent_run_record_id IS NULL
  AND agent != '(pending)';

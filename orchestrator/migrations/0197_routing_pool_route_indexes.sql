CREATE INDEX routing_pool_run_route
  ON routing_pool_run (job, prompt_bytes, agent, started_at DESC, record_id DESC);
--> statement-breakpoint
CREATE INDEX routing_pool_lens_lens_run
  ON routing_pool_lens (lens, run_record_id);

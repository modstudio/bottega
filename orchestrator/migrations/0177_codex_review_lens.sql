UPDATE agent
   SET jobs = json_insert(jobs, '$[#]', 'review-lens')
 WHERE harness = 'codex'
   AND billing = 'subscription'
   AND jobs IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM json_each(agent.jobs) WHERE value = 'review-lens');

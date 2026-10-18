CREATE INDEX question_delivery_question ON question_delivery(question_id, id);
CREATE INDEX run_automatic_failover_retry ON run(retry_of, id) WHERE automatic_failover = 1;

ALTER TABLE outbox ADD COLUMN actor_session TEXT
  CHECK (actor_session IS NULL OR length(actor_session) > 0);

CREATE INDEX outbox_quarantined_live ON outbox(id)
WHERE quarantined_at IS NOT NULL AND retired_at IS NULL;

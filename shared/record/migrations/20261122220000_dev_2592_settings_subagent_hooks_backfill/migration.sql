ALTER TABLE doc NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE doc_revision NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE doc
SET body=jsonb_set(
      body::jsonb,
      '{options}',
      COALESCE(body::jsonb->'options', '{}'::jsonb) || '{"subagentHooks":"on"}'::jsonb
    )::text,
    updated_at=clock_timestamp()
WHERE scope='settings'
  AND body::jsonb->'options'->>'subagentHooks' IS DISTINCT FROM 'on';--> statement-breakpoint
UPDATE doc_revision
SET body=jsonb_set(
      body::jsonb,
      '{options}',
      COALESCE(body::jsonb->'options', '{}'::jsonb) || '{"subagentHooks":"on"}'::jsonb
    )::text
WHERE scope='settings'
  AND body::jsonb->'options'->>'subagentHooks' IS DISTINCT FROM 'on';--> statement-breakpoint
ALTER TABLE doc FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE doc_revision FORCE ROW LEVEL SECURITY;

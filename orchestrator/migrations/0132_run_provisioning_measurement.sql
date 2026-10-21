ALTER TABLE run ADD COLUMN provisioning_kind TEXT CHECK (provisioning_kind IN ('writer','read-only'));
ALTER TABLE run ADD COLUMN provisioning_ms INTEGER;
ALTER TABLE run ADD COLUMN provisioning_phases TEXT;
ALTER TABLE run ADD COLUMN provisioning_entries INTEGER;
ALTER TABLE run ADD COLUMN provisioning_entries_limited INTEGER;
ALTER TABLE run ADD COLUMN provisioning_host_load TEXT;
ALTER TABLE run ADD COLUMN provisioning_outcome TEXT CHECK (provisioning_outcome IN ('ok','failed'));
ALTER TABLE run ADD COLUMN provisioning_entry_roots TEXT;

ALTER TABLE monitor_invocation ADD COLUMN host_load TEXT;

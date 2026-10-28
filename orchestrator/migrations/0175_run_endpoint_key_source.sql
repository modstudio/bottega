ALTER TABLE run ADD COLUMN endpoint_key_source TEXT CHECK (endpoint_key_source IN ('agent','project'));

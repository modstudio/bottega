ALTER TABLE agent ADD COLUMN request_settings TEXT CHECK (request_settings IS NULL OR json_valid(request_settings));

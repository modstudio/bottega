ALTER TABLE agent ADD COLUMN provider TEXT;

ALTER TABLE run ADD COLUMN credential_id TEXT;
ALTER TABLE run ADD COLUMN credential_payer TEXT CHECK (credential_payer IN ('personal','shared'));
ALTER TABLE run ADD COLUMN credential_binding TEXT CHECK (credential_binding IN ('space','project'));

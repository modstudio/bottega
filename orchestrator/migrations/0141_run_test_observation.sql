ALTER TABLE run ADD COLUMN tests_claim_disagrees INTEGER CHECK (tests_claim_disagrees IN (0,1));
